import { Debugger } from "./debugger";
const $d:Debugger = Debugger.Get();
const bcrypt = require('bcrypt-nodejs');
import * as express from "express";
const fs = require('fs');
import { MongoClient, Db, Collection, MongoError, InsertOneResult, ObjectId, FindCursor } from 'mongodb';
const path = require('path');
const crypto = require('crypto');

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

export function ErrOutText(msg:string, res: any) {
    res.setHeader('Content-Type', 'text/plain');
    res.send(msg);
}

export function GetCerts (priv: string, pub: string) : string[] {
    let certFiles : string[] = [priv, pub];
    const fs = require('fs');
    for (var i = 0; i < 2; i++) {
        if (!fs.existsSync(certFiles[i])) {
            $d.log((certFiles[i]+" not found. Run `sh ./ssl/gen.sh` to generate a self signed SSL certificate").red);
            break;
        }
    }
    return certFiles;
}

export function UncaughtExceptionHandler (err: any, dieOnException:boolean) : void {

    //const $t = $s.$t;

    //console.log(srv);
    $d.log("[EXCEPTION]".bgRed);
    $d.log(err);

    $d.log(err.stack);
    if (err && err.code && typeof err.code === 'string' && err.code.indexOf('EADDRINUSE') !== -1) Die("Port busy");
    if (dieOnException) {
        Die();
    }
}

export function Die (message?: string) : void{
    var m = "Kthxbye!";
    if (message) m += " [" + message + "]";
    $d.log(m.bgRed);
    process.exit(1);
}

export function GetCachedFileName(fileUrl:string) : string{
    let base = path.basename(fileUrl)
    // let ext = path.extname(req.params.FILE_URL);
    let hash = crypto.createHash('md5').update(fileUrl).digest("hex");
    return hash+'-'+base;
}

export async function SendEmail(to: string, subject: string, body: string, sender:string, sesClient:SESClient) {
    const params = {
        Destination: { ToAddresses: [to] },
        Message: {
            Body: { Text: { Data: body } },
            Subject: { Data: subject },
        },
        Source: sender,
    };
  
    try {
        const command = new SendEmailCommand(params);
        const response = await sesClient.send(command);
        $d.log("Email sent successfully:", response.MessageId);
    } catch (error) {
        $d.err("Error sending email:", error);
    }
}

export function GetDomainName(url: string): string | null {
  try {
    const urlObject = new URL(url);
    return urlObject.hostname;
  } catch (error) {
    console.error("Invalid URL:", error);
    return null;
  }
}