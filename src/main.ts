import https from "node:https";
import fs from "node:fs";

import express from "express";
import * as jsonc from "comment-json";
import C from "colors";
C; //force import typings with string prototype extension

import { GetCerts } from "./lib/helpers";
import { Collection, MongoClient } from "mongodb";

const UPLOAD_PORT: number = CONFIG["FILE_RECEIVER"].uploadPort;
const DB_URL: string = CONFIG.dbUrl;
const BRIDGE_SSL_CERT_PRIVATE = CONFIG["BRIDGE"].bridgeSsl.private;
const BRIDGE_SSL_CERT_PUBLIC = CONFIG["BRIDGE"].bridgeSsl.public;

const bridgeCertFiles: string[] = GetCerts(
  BRIDGE_SSL_CERT_PRIVATE,
  BRIDGE_SSL_CERT_PUBLIC,
);
const HTTPS_SERVER_OPTIONS = {
  key: fs.readFileSync(bridgeCertFiles[0]),
  cert: fs.readFileSync(bridgeCertFiles[1]),
};

let configFname = process.env.CONFIG_FILE ?? `${__dirname}/../config.jsonc`;
const CONFIG: any = jsonc.parse(fs.readFileSync(configFname).toString());

const FILES_CACHE_DIR: string = CONFIG["BRIDGE"].filesCacheDir;
const INCOMING_TMP_DIR: string = CONFIG["FILE_RECEIVER"].incomingFilesTmpDir;

let db: Db;
let robotsCollection: Collection;

const app = express();
const httpServer = https.createServer(HTTPS_SERVER_OPTIONS, app);

const mongoClient = new MongoClient(DB_URL);
mongoClient.connect().then((client) => {
  $d.log(("We are connected to " + DB_URL).green);

  db = client.db("phntm");

  robotsCollection = db.collection("robots");

  const $d: Debugger = Debugger.Get("Files");

  httpServer.listen(UPLOAD_PORT);
  console.log(`Upload server running on port ${UPLOAD_PORT}`);
});
