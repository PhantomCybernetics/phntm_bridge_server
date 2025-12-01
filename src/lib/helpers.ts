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
    let cert_files : string[] = [priv, pub];
    const fs = require('fs');
    for (var i = 0; i < 2; i++) {
        if (!fs.existsSync(cert_files[i])) {
            $d.log((cert_files[i]+" not found. Run `sh ./ssl/gen.sh` to generate a self signed SSL certificate").red);
            break;
        }
    }
    return cert_files;
}

export function UncaughtExceptionHandler (err: any, die_on_exception:boolean) : void {

    //const $t = $s.$t;

    //console.log(srv);
    $d.log("[EXCEPTION]".bgRed);
    $d.log(err);

    $d.log(err.stack);
    if (err && err.code && typeof err.code === 'string' && err.code.indexOf('EADDRINUSE') !== -1) Die("Port busy");
    if (die_on_exception) {
        Die();
    }
}

export function Die (message?: string) : void{
    var m = "Kthxbye!";
    if (message) m += " [" + message + "]";
    $d.log(m.bgRed);
    process.exit(1);
}

export function GetCachedFileName(file_url:string) : string{
    let base = path.basename(file_url)
    // let ext = path.extname(req.params.FILE_URL);
    let hash = crypto.createHash('md5').update(file_url).digest("hex");
    return hash+'-'+base;
}

export async function SendEmail(to: string, subject: string, body: string, sender:string, ses_client:SESClient) {
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
        const response = await ses_client.send(command);
        $d.log("Email sent successfully:", response.MessageId);
    } catch (error) {
        $d.err("Error sending email:", error);
    }
}

export function GetDomainName(url: string): string | null {
  try {
    const url_object = new URL(url);
    return url_object.hostname;
  } catch (error) {
    console.error("Invalid URL:", error);
    return null;
  }
}