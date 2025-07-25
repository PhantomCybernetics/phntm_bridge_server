import fs from "node:fs";
import z from "zod";
import path from "node:path";

import * as jsonc from "comment-json";

import { Debugger } from "../lib/debugger";

const booleanString = () =>
  z
    .enum(["true", "false"])
    .transform((val) => val === "true")
    .pipe(z.boolean());

// Schema for configuration coming from environment variables (which are all strings)
const envConfigSchema = z
  .object({
    dbUrl: z.string(),
    dbName: z.string(),
    dieOnException: booleanString(),

    port: z.coerce.number(),
    https: booleanString(),
    sslPrivateKey: z.string(),
    sslCert: z.string(),

    iceServers: z.string(),
    iceSyncPort: z.coerce.number(),
    iceSyncSecret: z.string(),

    filesCacheDir: z.string(),
    incomingFilesTmpDir: z.string(),
  })
  .partial();

// Full configuration schema
const configSchema = z.object({
  dbUrl: z.string(),
  dbName: z.string().default("phntm"),
  dieOnException: z.boolean().default(true),

  port: z.number().int().positive().default(443),
  https: z.boolean().default(true),
  sslPrivateKey: z.string().optional(),
  sslCert: z.string().optional(),

  iceServers: z.string().array(),
  iceSyncPort: z.number().int().positive(),
  iceSyncSecret: z.string(),

  filesCacheDir: z.string(),
  incomingFilesTmpDir: z.string(),
});

export type BridgeServerConfig = z.infer<typeof configSchema>;

export async function getConfig($d: Debugger): Promise<BridgeServerConfig> {
  const configFilePath =
    process.env.bridgeServerConfigFile ?? `${__dirname}/../config.jsonc`;

  const iceServersSet = new Set<string>();

  const { iceServers: envIceServers, ...envConfig } = envConfigSchema.parse(
    process.env,
  );
  if (envIceServers) {
    for (const server of envIceServers.split(",")) {
      iceServersSet.add(server);
    }
  }
  let fileConfig: any = {};
  if (fs.existsSync(configFilePath)) {
    $d.l(`Loading config from ${path.resolve(configFilePath)}`);
    fileConfig = jsonc.parse(fs.readFileSync(configFilePath).toString());
    if (fileConfig.iceServers) {
      for (const server of fileConfig.iceServers) {
        iceServersSet.add(server);
      }
    }
  }

  return configSchema.parse(
    Object.assign({}, fileConfig, envConfig, {
      iceServers: [...iceServersSet],
    }),
  );
}
