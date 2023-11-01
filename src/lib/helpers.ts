import { Debugger } from "./debugger";
const $d:Debugger = Debugger.Get();
const bcrypt = require('bcrypt-nodejs');
import * as express from "express";
import { MongoClient, Db, Collection, MongoError, InsertOneResult, ObjectId, FindCursor } from 'mongodb';
const yaml = require('js-yaml');
const fs = require('fs');

export function ErrOutText(msg:string, res: any) {
    res.setHeader('Content-Type', 'text/plain');
    res.send(msg);
}

export function RegisterRobot(req:express.Request, res:express.Response, set_password:string, robotsCollection:Collection) {
    let remote_ip:string = (req.headers['x-forwarded-for'] || req.socket.remoteAddress) as string;
    const saltRounds = 10;
    bcrypt.genSalt(saltRounds, async function (err:any, salt:string) {
        if (err) { $d.err('Error while generating salt'); return ErrOutText( 'Error while registering', res ); }

        bcrypt.hash(set_password, salt, null, async function (err:any, hash:string) {
            if (err) { $d.err('Error while hashing password'); return ErrOutText( 'Error while registering', res ); }

            let dateRegistered = new Date();

            let robotReg:InsertOneResult = await robotsCollection.insertOne({
                registered: dateRegistered,
                reg_ip: remote_ip,
                key_hash: hash
            });

            $d.l(('Registered new robot id '+robotReg.insertedId.toString()+' from '+remote_ip).yellow);

            if (req.query.yaml !== undefined) {
                return res.redirect('/robot/register?yaml&id='+robotReg.insertedId.toString()+'&key='+set_password);
            } else {
                return res.redirect('/robot/register?id='+robotReg.insertedId.toString()+'&key='+set_password);
            }
        });
    });
}

export async function GetDefaultRobotConfig(req:express.Request, res:express.Response, robotsCollection:Collection, public_address:string, sio_port:number) {

    if (!req.query.id || !ObjectId.isValid(req.query.id as string) || !req.query.key) {
        $d.err('Invalidid id_robot provided: '+req.query.id)
        res.status(403);
        return res.send('Access denied, invalid credentials');
    }

    let searchId = new ObjectId(req.query.id as string);
    const dbRobot = (await robotsCollection.findOne({_id: searchId }));

    if (dbRobot) {
        bcrypt.compare(req.query.key, dbRobot.key_hash, function(err:any, pass_res:any) {
            if (pass_res) { //pass match => good
                
                if (req.query.yaml !== undefined) {

                    const dir:string  = __dirname + "/../../";
                    let cfg:string = fs.readFileSync(dir+'robot_config.templ.yaml').toString(); 
                
                    cfg = cfg.replace('%HOST%', public_address);
                    cfg = cfg.replace('%REG_DATE_TIME%', dbRobot.registered.toISOString());
                    cfg = cfg.replace('%REG_IP%', dbRobot.reg_ip);

                    cfg = cfg.replace('%ROBOT_ID%', dbRobot._id.toString());
                    cfg = cfg.replace('%ROBOT_KEY%', req.query.key as string);

                    cfg = cfg.replace('%SIO_ADDRESS%', public_address);
                    cfg = cfg.replace('%SIO_PATH%', '/robot/socket.io');
                    cfg = cfg.replace('%SIO_PORT%', sio_port.toString());

                    res.setHeader('Content-Type', 'application/text');
                    res.setHeader('Content-Disposition', 'attachment; filename="phntm_bridge.yaml"');

                    return res.send(cfg);

                } else { // json - this is not very useful yet
                    // $d.l(dbRobot);
                    res.setHeader('Content-Type', 'application/json');
                    return res.send(JSON.stringify({
                        id_robot: dbRobot._id.toString(),
                        key: req.query.key,
                        sio_address: public_address,
                        sio_path: '/robot/socket.io',
                        sio_port: sio_port,
                    }, null, 4));
                }

            } else { //invalid key
                res.status(403);
                return res.send('Access denied, invalid credentials');
            }
        });

    } else { //robot not found
        res.status(403);
        return res.send('Access denied, invalid credentials');
    }

}

export function RegisterApp(req:express.Request, res:express.Response, set_password:string, appsCollection:Collection) {
    let remote_ip:string = (req.headers['x-forwarded-for'] || req.socket.remoteAddress) as string;
    const saltRounds = 10;
    bcrypt.genSalt(saltRounds, async function (err:any, salt:string) {
        if (err) { $d.err('Error while generating salt'); return ErrOutText( 'Error while registering', res ); }

        bcrypt.hash(set_password, salt, null, async function (err:any, hash:string) {
            if (err) { $d.err('Error while hashing password'); return ErrOutText( 'Error while registering', res ); }

            let dateRegistered = new Date();

            let appReg:InsertOneResult = await appsCollection.insertOne({
                registered: dateRegistered,
                reg_ip: remote_ip,
                key_hash: hash
            });

            let new_config:any = {
                appId: appReg.insertedId.toString(),
                appKey: set_password
            };

            res.setHeader('Content-Type', 'application/json');
            res.send(JSON.stringify(new_config, null, 4));
            return;

        });
    });
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



