import path from "node:path";
import https from "node:https";

import bcrypt from "bcrypt-nodejs";
import C from "colors";
import * as JSONC from "comment-json";
import express from "express";
import fs from "fs-extra";
import { MongoClient, Db, Collection, ObjectId } from "mongodb";
import multer from "multer";

C; //force import typings with string prototype extension

import { GetCachedFileName, GetCerts } from "./lib/helpers";
import { Debugger } from "./lib/debugger";

const $d: Debugger = Debugger.Get("Files");

let configFname = process.env.CONFIG_FILE ?? `${__dirname}/../config.jsonc`;
const CONFIG: any = JSONC.parse(fs.readFileSync(configFname).toString());

const FILES_CACHE_DIR: string = CONFIG["BRIDGE"].filesCacheDir;
if (FILES_CACHE_DIR && !fs.existsSync(FILES_CACHE_DIR)) {
  $d.e("Files cache dir not found: " + FILES_CACHE_DIR);
  process.exit();
}
const UPLOAD_PORT: number = CONFIG["FILE_RECEIVER"].uploadPort;
const INCOMING_TMP_DIR: string = CONFIG["FILE_RECEIVER"].incomingFilesTmpDir;
const BRIDGE_SSL_CERT_PRIVATE = CONFIG["BRIDGE"].bridgeSsl.private;
const BRIDGE_SSL_CERT_PUBLIC = CONFIG["BRIDGE"].bridgeSsl.public;
const DB_URL: string = CONFIG.dbUrl;

const bridgeCertFiles: string[] = GetCerts(
  BRIDGE_SSL_CERT_PRIVATE,
  BRIDGE_SSL_CERT_PUBLIC,
);
const HTTPS_SERVER_OPTIONS = {
  key: fs.readFileSync(bridgeCertFiles[0]),
  cert: fs.readFileSync(bridgeCertFiles[1]),
};

const app = express();
const httpServer = https.createServer(HTTPS_SERVER_OPTIONS, app);
const upload = multer({ dest: INCOMING_TMP_DIR });

interface UploadedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  destination: string;
  filename: string;
  path: string;
  size: number;
}

async function checkAuth(idRobot: string, authKey: string): Promise<void> {
  return new Promise<void>(async (resolve, reject) => {
    if (!idRobot || !ObjectId.isValid(idRobot) || !authKey) {
      $d.l(("Invalid robot id " + idRobot + " or key").red);
      return reject();
    }

    let searchId = new ObjectId(idRobot);
    const dbRobot = await robotsCollection.findOne({ _id: searchId });

    if (dbRobot) {
      bcrypt.compare(
        authKey,
        dbRobot.key_hash,
        function (err: any, resPass: any) {
          if (resPass) {
            //pass match => good
            return resolve();
          } else {
            //invalid key
            $d.l(("Robot " + idRobot + " auth failed").red);
            return reject();
          }
        },
      );
    } else {
      //robot not found
      $d.l(("Robot " + idRobot + " not found in db").red);
      return reject();
    }
  });
}

app.post("/upload", upload.single("file"), async (req: any, res: any) => {
  try {
    const file = req.file as UploadedFile;
    let json = JSON.parse(req.body.json);
    let fileUrl = json["fileUrl"];
    const idRobot = json["idRobot"];
    const authKey = json["key"];

    await checkAuth(idRobot, authKey)
      .then(async () => {
        if (!file) {
          return res.status(400).json({ error: "No file uploaded" });
        }

        const { originalname, path: tempPath } = file;
        const [originalFileName, partNumber] = originalname.split(".part");
        const fileName = GetCachedFileName(fileUrl);
        const chunksDir = path.join(
          FILES_CACHE_DIR + "/" + idRobot + "/",
          fileName + ".chunks",
        );
        const targetPath = path.join(chunksDir, `part${partNumber}`);

        await fs.ensureDir(chunksDir);
        await fs.move(tempPath, targetPath, { overwrite: true });

        $d.log(
          "[" +
            idRobot +
            "] " +
            ("Chunk " + partNumber + " of " + fileName + " ok").cyan,
        );
        res.json({ message: "Chunk ok", partNumber });
      })
      .catch(() => {
        res.status(403).json({ error: "Invalid credentials provided" });
      });
  } catch (error) {
    $d.e("Error handling file upload:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/complete", express.json(), async (req: any, res: any) => {
  try {
    const { idRobot, authKey, fileUrl, totalParts } = req.body;
    const fileName = GetCachedFileName(fileUrl);
    const chunksDir = path.join(
      FILES_CACHE_DIR + "/" + idRobot + "/",
      fileName + ".chunks",
    );
    const targetPath = path.join(
      FILES_CACHE_DIR + "/" + idRobot + "/",
      fileName,
    );

    await checkAuth(idRobot, authKey)
      .then(async () => {
        $d.log(
          "[" + idRobot + "] " + ("Combining chunks of " + fileName).green,
        );

        const writeStream = fs.createWriteStream(targetPath);

        for (let i = 0; i < totalParts; i++) {
          const chunkPath = path.join(chunksDir, `part${i}`);
          const chunkStream = fs.createReadStream(chunkPath);
          await new Promise((resolve_chunk, reject_chunk) => {
            chunkStream.pipe(writeStream, { end: false });
            chunkStream.on("end", resolve_chunk);
            chunkStream.on("error", reject_chunk);
          });
          await fs.remove(chunkPath);
        }

        writeStream.end();
        await fs.remove(chunksDir);

        res.json({ fileName: fileName });
      })
      .catch(() => {
        res.status(403).json({ error: "Invalid credentials provided" });
      });
  } catch (error) {
    $d.e("Error completing file upload:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/clear_cache", express.json(), async (req: any, res: any) => {
  try {
    const { idRobot, authKey } = req.body;
    const clearPath = path.join(FILES_CACHE_DIR + "/" + idRobot);

    await checkAuth(idRobot, authKey)
      .then(async () => {
        $d.log("[" + idRobot + "] " + "Clearing files cache".green);

        await fs.remove(clearPath);

        res.send("Cloud file cache cleared");
      })
      .catch(() => {
        res.status(403).send("Invalid credentials provided");
      });
  } catch (error) {
    $d.e("Error completing clear cache request:", error);
    res.status(500).send("Error completing clear cache request");
  }
});

let db: Db = null;
let robotsCollection: Collection = null;
const mongoClient = new MongoClient(DB_URL);
mongoClient.connect().then((client: MongoClient) => {
  $d.log(("We are connected to " + DB_URL).green);

  db = client.db("phntm");
  robotsCollection = db.collection("robots");

  httpServer.listen(UPLOAD_PORT);
  console.log(`Upload server running on port ${UPLOAD_PORT}`);
});
