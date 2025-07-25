import https from "node:https";
import http from "node:http";
import fs from "node:fs";

import express from "express";
import { MongoClient } from "mongodb";
import C from "colors";
C; //force import typings with string prototype extension

import { validateSslCertificateFiles } from "../lib/helpers";
import { Debugger } from "../lib/debugger";
import { getConfig } from "../src/config";
import { setupFileReceiver } from "../src/FileReceiver";
import { setupFileRequester } from "../src/FileRequester";

const $d: Debugger = Debugger.Get("Bridge Server");
const config = await getConfig($d);

function httpsOptions() {
  const { sslPrivateKey, sslCert } = validateSslCertificateFiles({
    $d,
    ...config,
  });
  return {
    key: fs.readFileSync(sslPrivateKey),
    cert: fs.readFileSync(sslCert),
  };
}

const mongoClient = new MongoClient(config.dbUrl);
mongoClient.connect().then((client) => {
  $d.log(
    `We are connected to ${config.dbUrl}, using db ${config.dbName}`.green,
  );

  const db = client.db(config.dbName);
  const robotsCollection = db.collection("robots");

  const app = express();
  setupFileReceiver(
    { $d: Debugger.Get("File Receiver"), ...config, robotsCollection },
    app,
  );
  setupFileRequester({ $d: Debugger.Get("File Requester"), ...config }, app);

  const httpServer = config.https
    ? https.createServer(httpsOptions(), app)
    : http.createServer(app);

  httpServer.listen(config.port);
  console.log(
    `${config.https ? "HTTPS" : "HTTP"} bridge server listening on port ${config.port}`
      .green,
  );
});
