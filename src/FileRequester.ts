import fs from "node:fs";

import { type Express, type RequestHandler } from "express";
import cors from "cors";

import { App } from "./App";
import { ObjectId } from "mongodb";
import { Robot } from "./Robot";
import { GetCachedFileName } from "../lib/helpers";
import { Debugger } from "../lib/debugger";

interface RequestFileDeps {
  $d: Debugger;
  filesCacheDir: string;
}

const requestFileRoute =
  (deps: RequestFileDeps): RequestHandler =>
  async (req, res) => {
    const { $d, filesCacheDir } = deps;

    let auth_ok = false;
    let connectedApp: App | null = null;
    for (let i = 0; i < App.connectedApps.length; i++) {
      connectedApp = App.connectedApps[i];
      if (req.params.SECRET === App.connectedApps[i].filesSecret.toString()) {
        auth_ok = true;
        break;
      }
    }

    let remote_ip: string = (req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress) as string;

    if (!auth_ok || !connectedApp) {
      $d.e(
        "Access to file fw denied " +
          req.params.FILE_URL +
          "; secret=" +
          req.params.SECRET +
          "; IP=" +
          remote_ip,
      );
      return res.sendStatus(403); //access denied
    }
    const app = connectedApp;

    if (!req.params.ID_ROBOT || !ObjectId.isValid(req.params.ID_ROBOT)) {
      $d.e("Invalid id robot in file request:", req.params);
      return res.sendStatus(400); //bad request
    }
    let id_robot = new ObjectId(req.params.ID_ROBOT);
    let robot = Robot.FindConnected(id_robot);
    if (!robot || !robot.socket) {
      $d.e("Error seding cached file, robot " + id_robot + " not connected");
      return res.sendStatus(502); //bad gateway
    }
    $d.l(
      (
        "App inst #" +
        app.idInstance.toString() +
        " reguested " +
        req.params.FILE_URL +
        " for robot #" +
        id_robot
      ).cyan,
    );

    let fname_cache = GetCachedFileName(req.params.FILE_URL);

    let path_cache =
      filesCacheDir + "/" + id_robot.toString() + "/" + fname_cache;

    if (!filesCacheDir) {
      $d.e("Files cache dir not set");
      return res.sendStatus(500); // not caching but should => internal server error
    }

    try {
      await fs.promises.access(path_cache, fs.constants.R_OK);
      $d.l(path_cache + " found in cache");

      return res.sendFile(path_cache, {}, function (err) {
        try {
          if (err) {
            $d.e("Error sending cached file " + path_cache, err);
            return res.sendStatus(500); // internal server error
          }
        } catch (err1) {
          $d.l("Exception caught and ignored", err1);
        }
      });
    } catch (err) {
      $d.l(fname_cache + " not found in server cache");

      // check cache folder
      try {
        await fs.promises.access(
          filesCacheDir + "/" + id_robot.toString(),
          fs.constants.R_OK | fs.constants.W_OK,
        );
      } catch (err1) {
        try {
          $d.l(
            "Creating cache dir: " + filesCacheDir + "/" + id_robot.toString(),
          );
          await fs.promises.mkdir(filesCacheDir + "/" + id_robot.toString(), {
            recursive: false,
          });
        } catch (err2) {
          if (err2.code != "EEXIST") {
            // created since first check
            $d.e(
              "Failed to create cache dir: " +
                filesCacheDir +
                "/" +
                id_robot.toString(),
              err2,
            );
            return res.sendStatus(500); // not caching but should => internal server error
          }
        }
      }
    }

    // fetch the file from robot
    $d.l("Fetching file from robot... ");

    return robot.socket.emit(
      "file",
      req.params.FILE_URL,
      async (robot_res: any) => {
        if (!robot_res || robot_res.err || !robot_res.fileName) {
          $d.e("Robot returned error... ", robot_res);
          return res.sendStatus(404); // not found
        }

        $d.l(("Robot uploaded file " + robot_res.fileName).cyan);

        if (!path_cache.endsWith(robot_res.fileName)) {
          $d.l("Robot returned wrong file name, requested: ", path_cache);
          return res.sendStatus(404); // not found
        }

        try {
          await fs.promises.access(path_cache, fs.constants.R_OK);
          return res.sendFile(path_cache, {}, function (err) {
            try {
              if (err) {
                $d.e("Error sending cached file " + path_cache, err);
                return res.sendStatus(500); // internal server error
              }
            } catch (err1) {
              $d.l("Exception caught and ignored", err1);
            }
          });
        } catch (err) {
          $d.l(fname_cache + " not found in server cache");
          return res.sendStatus(404); // not found
        }
      },
    );
  };

export function setupFileRequester(deps, app: Express) {
  app.get(
    "/:ID_ROBOT/file-from-robot/:SECRET/:FILE_URL",
    cors(),
    requestFileRoute(deps),
  );
}
