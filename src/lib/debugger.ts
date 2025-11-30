//const C = require('colors'); //force import typings with string prototype extension
// import * as C from 'colors';

class Debugger {

    label: string = '';
    static instance:Debugger|null = null;

    static Get(label?:string) {
        if (Debugger.instance === null) {
            Debugger.instance  = new Debugger();
        }
        if (label) {
            Debugger.instance.label = label;
        }
        return Debugger.instance;
    }

    constructor () {

    }

    getTime():string {
        let d = new Date();
        let t = d.toUTCString();
        return t;
    }

    l (data: any, ...args: any[]) : void {
        if (args.length)
            return this.log(data, args);
        else
            return this.log(data);
    }
    log(data: any, ...args: any[]): void {
        let t = this.getTime();
        if (args.length > 0) {
            console.log(`[${this.label} ${t}]`, data, args.length > 1 ? args : args[0]);
        } else {
            console.log(`[${this.label} ${t}]`, data);
        }
    }

    e(data: string, ...args: any[]):void {
        if (args.length)
            return this.err(data, args);
        else
            return this.err(data);
    }
    err (data: string, ...args: any[]) : void {
        let t = this.getTime();
        if (args.length > 0) {
            console.log(`[${this.label} ${t}]`, data.red, args.length > 1 ? args : args[0]);
        } else {
            console.log(`[${this.label} ${t}]`, data.red);
        }
    }
}



export { Debugger };
