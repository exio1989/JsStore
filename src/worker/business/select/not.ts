import { NotWhere } from "./not_where";
let skipOrPush: (val) => void;
let skip;
let shouldAddValue: () => boolean;
let cursor: IDBCursorWithValue;
export class Not extends NotWhere {
    compValue: string;
    protected executeLikeLogic_(column, value: string) {
        skip = this.skipRecord;
        skipOrPush = (val) => {
            if (skip === 0) {
                this.results.push(val);
            }
            else {
                --skip;
            }
        };
        if (this.checkFlag) {
            shouldAddValue = () => {
                return this.filterOnOccurence(cursor.key) &&
                    this.whereCheckerInstance.check(cursor.value);
            };
        }
        else {
            shouldAddValue = () => {
                return this.filterOnOccurence(cursor.key);
            };
        }
        this.compValue = value.toLowerCase();
        this.cursorOpenRequest = this.objectStore.index(column).openCursor();
        this.cursorOpenRequest.onerror = function (e) {
            this._errorOccured = true;
            this.onErrorOccured(e);
        }.bind(this);
        if (this.skipRecord && this.limitRecord) {
            this.executeSkipAndLimit_();
        }
        else if (this.skipRecord) {
            this.executeSkip_();
        }
        else if (this.limitRecord) {
            this.executeLimit_();
        }
        else {
            this.executeSimple_();
        }
    }

    private executeSkipAndLimit_() {
        this.cursorOpenRequest.onsuccess = (e: any) => {
            cursor = e.target.result;
            if (this.results.length !== this.limitRecord && cursor) {
                if (shouldAddValue()) {
                    skipOrPush(cursor.value);
                }
                cursor.continue();
            } else {
                this.onQueryFinished();
            }
        };
    }

    private executeSkip_() {
        this.cursorOpenRequest.onsuccess = (e: any) => {
            cursor = e.target.result;
            if (cursor) {
                if (shouldAddValue()) {
                    skipOrPush((cursor.value));
                }
                cursor.continue();
            } else {
                this.onQueryFinished();
            }
        };
    }

    private executeLimit_() {

        this.cursorOpenRequest.onsuccess = (e: any) => {
            cursor = e.target.result;
            if (this.results.length !== this.limitRecord && cursor) {
                if (shouldAddValue()) {
                    this.results.push(cursor.value);
                }
                cursor.continue();
            } else {
                this.onQueryFinished();
            }
        };
    }

    private executeSimple_() {
        this.cursorOpenRequest.onsuccess = (e: any) => {
            cursor = e.target.result;
            if (cursor) {
                if (shouldAddValue()) {
                    this.results.push(cursor.value);
                }
                cursor.continue();
            } else {
                this.onQueryFinished();
            }
        };
    }
}