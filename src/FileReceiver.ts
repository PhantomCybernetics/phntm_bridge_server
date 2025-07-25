import path from "node:path";

import bcrypt from "bcrypt-nodejs";
import express, { type Express, type RequestHandler } from "express";
import fs from "fs-extra";
import { Collection, ObjectId } from "mongodb";
import multer from "multer";

import { GetCachedFileName } from "../lib/helpers";
import { Debugger } from "../lib/debugger";

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

interface CheckAuthDeps {
  $d: Debugger;
  robotsCollection: Collection;
}

interface FileReceiverDeps extends CheckAuthDeps {
  filesCacheDir: string;
}

async function checkAuth(
  { robotsCollection, $d }: CheckAuthDeps,
  idRobot: string,
  authKey: string,
): Promise<void> {
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

const uploadRoute =
  (deps: FileReceiverDeps): RequestHandler =>
  async (req, res) => {
    const { $d, filesCacheDir: FILES_CACHE_DIR } = deps;
    try {
      const file = (req as any).file as UploadedFile;
      let json = JSON.parse(req.body.json);
      let fileUrl = json["fileUrl"];
      const idRobot = json["idRobot"];
      const authKey = json["key"];

      await checkAuth(deps, idRobot, authKey)
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
  };

const completeRoute =
  (deps: FileReceiverDeps): RequestHandler =>
  async (req, res) => {
    const { $d, filesCacheDir: FILES_CACHE_DIR } = deps;
    try {
      const { idRobot, authKey, fileUrl, totalParts } = req.body as any;
      const fileName = GetCachedFileName(fileUrl);
      const chunksDir = path.join(
        FILES_CACHE_DIR + "/" + idRobot + "/",
        fileName + ".chunks",
      );
      const targetPath = path.join(
        FILES_CACHE_DIR + "/" + idRobot + "/",
        fileName,
      );

      await checkAuth(deps, idRobot, authKey)
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
  };

const clearCacheRoute =
  (deps: FileReceiverDeps): RequestHandler =>
  async (req, res) => {
    const { $d, filesCacheDir: FILES_CACHE_DIR } = deps;
    try {
      const { idRobot, authKey } = req.body;
      const clearPath = path.join(FILES_CACHE_DIR + "/" + idRobot);

      await checkAuth(deps, idRobot, authKey)
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
  };

export function setupFileReceiver(
  deps: FileReceiverDeps & {
    incomingFilesTmpDir: string;
  },
  app: Express,
) {
  const { $d, incomingFilesTmpDir, filesCacheDir } = deps;

  if (filesCacheDir && !fs.existsSync(filesCacheDir)) {
    $d.e("Files cache dir not found: " + filesCacheDir);
    process.exit();
  }

  const upload = multer({ dest: incomingFilesTmpDir });
  app.post("/upload", upload.single("file"), uploadRoute(deps));
  app.post("/complete", express.json(), completeRoute(deps));
  app.post("/clear_cache", express.json(), clearCacheRoute(deps));
}
