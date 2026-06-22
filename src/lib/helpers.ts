import { Debugger } from "./debugger";
const $d:Debugger = Debugger.Get();
const bcrypt = require('bcrypt-nodejs');
import * as express from "express";
const fs = require('fs');
import { MongoClient, Db, Collection, MongoError, InsertOneResult, ObjectId, FindCursor } from 'mongodb';
const path = require('path');
const crypto = require('crypto');

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

export function ErrOutText(msg:string, res: any, status:number=500) {
    res.setHeader('Content-Type', 'text/plain');
    res.status(status);
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

export async function SendEmail_UI_Link(robot_id:string, robot_name:string, maintainer_email:string, ui_address_prefix:string, sender:string, sesClient:SESClient) {
  $d.log('Sending link to robot ' + robot_id + ' to '+ maintainer_email +'...');
  let subject = robot_name + ' on Phantom Bridge';
  let body = 'Hello,\n\n' +
              'Your robot '+robot_name+' is available at:\n\n' +
              ui_address_prefix + robot_id + '\n\n' +
              'Read the docs here: https://docs.phntm.io/bridge' + '\n\n' +
              '- Phantom Bridge';
  SendEmail(maintainer_email, subject, body, sender, sesClient);
}

export async function SendEmail(to: string, subject: string, body: string, sender:string, ses_client:SESClient) {
    const params = {
        Destination: { ToAddresses: [ to ] },
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

export function HashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;  // 32‑bit signed
  }
  return ((hash >>> 0).toString(16)).padStart(8, "0"); // convert to 8‑char hex (0–9A–F only)
}

export function GetRobotFilePublicUrl(fname_cache:string, mtime:any, id_robot: ObjectId, public_bridge_address:string, files_port:number, cdn_prefix:string):string {
    const mt_hash = HashString(mtime.toUTCString());
    if (cdn_prefix)
      return cdn_prefix + '/' + id_robot.toString() + '/' + mt_hash + '/' + fname_cache;
    else
      return public_bridge_address + ':' + files_port + '/' + id_robot.toString() + '/' + mt_hash + '/' + fname_cache;
}

export function FormatBytes(b: number, mib = false): string {
  const unit = mib ? 1024 : 1000;
  const GB = unit * unit * unit;
  const MB = unit * unit;
  const KB = unit;

  if (b > GB) {
    return `${(b / GB).toFixed(2)}${mib ? "GiB" : "GB"}`;
  } else if (b > MB) {
    return `${(b / MB).toFixed(2)}${mib ? "MiB" : "MB"}`;
  } else if (b > KB) {
    return `${(b / KB).toFixed(2)}${mib ? "KiB" : "KB"}`;
  } else if (b > 0) {
    return `${b.toFixed(2)}B`;
  } else {
    return `0B`;
  }
}

export function URLNotCommonHackingAttempt(url:string):boolean {
  if (!url)
    return false;
  return !(url.includes('php') ||
           url.includes('.env') ||
           url.includes('aspx') ||
           url.includes('/api') ||
           url.includes('.git')
          );
}

export function SendFavicon(res: express.Response, favicon:string):void {
  res.setHeader('Content-Type', 'image/png');
  res.sendFile(path.join(__dirname, '..', '..', 'static/favicons', favicon));
}

export function SendFRobotsTxt(res: express.Response):void {
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(path.join(__dirname, '..', '..', 'static/robots.txt'));
}