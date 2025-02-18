import { Select } from "./";
import { IJoinQuery, DATA_TYPE, ERROR_TYPE, ISelectQuery, IErrorType } from "@/common";
import { getDataType, LogHelper, removeSpace, promiseReject, getKeys, getLength } from "@/worker/utils";
import { WhereChecker } from "@executors/where_checker";


export const executeJoinQuery = function (this: Select) {
    return new Join(this).execute();
}

interface JoinQueryWithInfo extends IJoinQuery {
    joinTableInfo: JoinTableInfo
}

class Join {

    private joinQueryStack_: JoinQueryWithInfo[] = [];
    private currentQueryStackIndex_ = 0;
    tablesFetched = [];
    results = [];

    select: Select;
    constructor(select: Select) {
        this.select = select;
    }

    get query() {
        return this.select.query;
    }

    getTable(name: string) {
        return this.select.table(name);
    }

    private executeSelect(query: ISelectQuery) {
        // this.select.util.emptyTx();
        return new Select(query, this.select.util).
            execute();
    }

    execute() {
        const query = this.query;
        this.joinQueryStack_ = getDataType(query.join) === DATA_TYPE.Object ?
            [query.join as JoinQueryWithInfo] : query.join as JoinQueryWithInfo[];
        // get the data for first table
        const tableName = query.from;
        const tablesToFetch = [];
        if (tableName) {
            tablesToFetch.push(tableName);
        }
        const joinQueryStack = this.joinQueryStack_;
        for (let i = 0, length = joinQueryStack.length; i < length; i++) {
            const item = joinQueryStack[i];
            let jointblInfo = this.getJoinTableInfo_(item.on);
            // table 1 is fetched & table2 needs to be fetched for join
            if (item.with === jointblInfo.table1.table) {
                jointblInfo = {
                    table1: jointblInfo.table2,
                    table2: jointblInfo.table1
                };
            }

            const err = this.checkJoinQuery_(jointblInfo, item);
            if (err) {
                return promiseReject(err);
            }
            joinQueryStack[i].joinTableInfo = jointblInfo;
            if (item.with) {
                tablesToFetch.push(item.with)
            }
        }

        if (!this.select.isTxQuery && tablesToFetch.length > 0) {
            this.select.util.createTransaction(tablesToFetch);
        }

        return this.executeSelect({
            from: tableName,
            where: query.where,
            case: query.case,
            flatten: query.flatten,
            store: query.store,
            meta: query.meta
        }).then(results => {
            this.results = results.map((item) => {
                return {
                    [this.currentQueryStackIndex_]: item
                };
            });
            this.tablesFetched.push(
                joinQueryStack[0].joinTableInfo.table1.table
            );
            return this.startExecutingJoinLogic_();
        });
    }

    private onJoinQueryFinished_() {
        if (this.results.length === 0) return;
        const selectApi = this.select;
        try {
            let results = [];
            const tables = getKeys(this.results[0]);
            const tablesLength = tables.length;
            this.results.forEach((result) => {
                let data = result["0"]; // first table data
                for (let i = 1; i < tablesLength; i++) {
                    data = { ...data, ...result[i] };
                }
                results.push(data);
            });
            selectApi['results'] = results;
            selectApi.setLimitAndSkipEvaluationAtEnd_();
            selectApi.query.flatten = null;
            if (process.env.NODE_ENV !== 'production') {
                try {
                    selectApi.processOrderBy();
                }
                catch (ex) {
                    return promiseReject(
                        new LogHelper((ERROR_TYPE as IErrorType).InvalidOrderQuery, ex.message)
                    );
                }
            }
            else {
                selectApi.processOrderBy();
            }
        }
        catch (ex) {
            return promiseReject(
                new LogHelper(ERROR_TYPE.InvalidJoinQuery, ex.message)
            );
        }
    }

    private startExecutingJoinLogic_() {
        const joinQuery = this.joinQueryStack_[this.currentQueryStackIndex_];
        if (joinQuery) {
            try {
                let jointblInfo = joinQuery.joinTableInfo;
                return this.executeSelect({
                    from: joinQuery.with,
                    where: joinQuery.where,
                    case: joinQuery.case,
                    flatten: joinQuery.flatten,
                    store: joinQuery.store,
                    meta: joinQuery.meta
                }).then(results => {
                    this.jointables(joinQuery, jointblInfo, results);
                    this.tablesFetched.push(jointblInfo.table2.table);
                    ++this.currentQueryStackIndex_;
                    return this.startExecutingJoinLogic_();
                });
            }
            catch (ex) {
                return promiseReject(
                    new LogHelper(ERROR_TYPE.InvalidJoinQuery, ex.message)
                );
            }
        }
        else {
            return this.onJoinQueryFinished_();
        }
    }

    private jointables(joinQuery: JoinQueryWithInfo, jointblInfo: JoinTableInfo, secondtableData: any[]) {
        const joinType = joinQuery.type;
        const output = [];
        const column1 = jointblInfo.table1.column;
        const column2 = jointblInfo.table2.column;
        const table1Index = this.tablesFetched.indexOf(jointblInfo.table1.table);
        const table2Index = this.currentQueryStackIndex_ + 1;
        const asQuery = joinQuery.as;
        const mapWithAlias = asQuery ? (value: object) => {
            for (const key in asQuery) {
                const asValue = asQuery[key];
                if (value[asValue] === undefined) {
                    value[asValue] = value[key];
                    delete value[key];
                }
            }
            return value;
        } : (val) => val;
        const performInnerJoin = () => {
            let index = 0;
            this.results.forEach(valueFromFirstTable => {
                secondtableData.forEach((valueFromSecondTable) => {
                    if (valueFromFirstTable[table1Index][column1] === valueFromSecondTable[column2]) {
                        output[index] = { ...valueFromFirstTable };
                        output[index++][table2Index] = mapWithAlias({ ...valueFromSecondTable });
                    }
                });
            });
        };
        const performleftJoin = () => {
            let index = 0;
            let valueMatchedFromSecondTable: any[];
            let callBack;
            const columnDefaultValue = {};
            const nullValue = null;
            if (joinQuery.store) {
                getKeys(joinQuery.store).forEach(columnName => {
                    columnDefaultValue[columnName] = nullValue;
                })
            }
            else {
                this.getTable(jointblInfo.table2.table).columns.forEach(col => {
                    columnDefaultValue[col.name] = nullValue;
                });
            }

            if (table2Index === 1) {
                callBack = function (valueFromSecondTable, valueFromFirstTable) {
                    if (valueFromFirstTable[table1Index][column1] === valueFromSecondTable[column2]) {
                        valueMatchedFromSecondTable.push(valueFromSecondTable);
                    }
                };
            }
            else {
                callBack = function (valueFromSecondTable, valueFromFirstTable) {
                    const value = valueFromFirstTable[table1Index];
                    if (value != null && value[column1] === valueFromSecondTable[column2]) {
                        valueMatchedFromSecondTable.push(valueFromSecondTable);
                    }
                };
            }
            const whereQry = Object.assign(joinQuery.where || {}, joinQuery['whereJoin'] || {});
            const whereCheker = new WhereChecker(whereQry, getLength(whereQry) > 0);
            this.results.forEach((valueFromFirstTable) => {
                valueMatchedFromSecondTable = [];
                // perform left join
                secondtableData.forEach(val => {
                    callBack(val, valueFromFirstTable)
                });

                if (valueMatchedFromSecondTable.length === 0) {
                    valueMatchedFromSecondTable = [columnDefaultValue];
                }

                valueMatchedFromSecondTable.forEach(function (value) {
                    value = mapWithAlias(value);
                    if (!whereCheker.check(value)) return;

                    output[index] = { ...valueFromFirstTable };
                    output[index++][table2Index] = value;
                });
            });
        };
        switch (joinType) {
            case "left":
                performleftJoin(); break;
            default:
                performInnerJoin();
        }
        this.results = output;
    }

    private getJoinTableInfo_(joinOn: string) {
        joinOn = removeSpace(joinOn);
        const splittedjoinOn = joinOn.split("=");
        const splittedjoinOnbydotFirst = splittedjoinOn[0].split(".");
        const splittedjoinOnbydotSecond = splittedjoinOn[1].split(".");
        const info = {
            table1: {
                table: splittedjoinOnbydotFirst[0],
                column: splittedjoinOnbydotFirst[1]
            },
            table2: {
                table: splittedjoinOnbydotSecond[0],
                column: splittedjoinOnbydotSecond[1]
            }
        } as JoinTableInfo;
        return info;
    }

    private checkJoinQuery_(jointblInfo: JoinTableInfo, qry: IJoinQuery) {
        if (qry.store) return null;

        const table1 = jointblInfo.table1;
        const table2 = jointblInfo.table2;
        const tableSchemaOf1stTable = this.getTable(table1.table);
        const tableSchemaOf2ndTable = this.getTable(table2.table);
        let err: LogHelper;
        // check on info & with info 
        if (qry.with !== table2.table) {
            err = new LogHelper(ERROR_TYPE.InvalidJoinQuery,
                `on value should contains value of with`
            );
        }

        // check for column existance
        if (tableSchemaOf1stTable.columns.find(q => q.name === table1.column) == null) {
            err = new LogHelper(ERROR_TYPE.InvalidJoinQuery,
                `column ${table1.column} does not exist in table ${table1.table}`
            );
        }
        else if (tableSchemaOf2ndTable.columns.find(q => q.name === table2.column) == null) {
            err = new LogHelper(ERROR_TYPE.InvalidJoinQuery,
                `column ${table2.column} does not exist in table ${table2.table}`
            );
        }

        // check for column match in both table
        if (qry.as == null) {
            qry.as = {};
        }
        tableSchemaOf1stTable.columns.every(function (column) {
            const columnFound = tableSchemaOf2ndTable.columns.find(q => q.name === column.name && q.name !== table1.column);
            if (columnFound != null && qry.as[columnFound.name] == null) {
                err = new LogHelper(ERROR_TYPE.InvalidJoinQuery,
                    `column ${column.name} exist in both table ${table1.table} & ${table2.table}`
                );
                return false;
            }
            return true;
        });
        const whereQry = qry.where;
        if (whereQry) {
            const whereJoin = {};
            for (const key in whereQry) {
                // const whereQueryVal = whereQry[key];
                const columnFound = tableSchemaOf2ndTable.columns.find(q => q.name === key);
                if (!columnFound) {
                    whereJoin[key] = whereQry[key];
                    delete whereQry[key];
                }
            }
            qry['whereJoin'] = whereJoin;
            if (getLength(whereQry) === 0) {
                qry.where = null;
            }
        }
        return err;
    }
}

type JoinTableInfo = {
    table1: { table: string, column: string }
    table2: { table: string, column: string }
};