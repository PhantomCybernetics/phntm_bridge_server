import * as SocketIO from "socket.io";
import { ObjectId } from "mongodb";

export class AppSocket extends SocketIO.Socket {}

export class App {
  idApp: ObjectId;
  idInstance: ObjectId;
  filesSecret: ObjectId;
  name: string;
  isConnected: boolean;
  isAuthentificated: boolean;
  socket: AppSocket | null;
  servedMsgDefs: string[] = [];
  robotSubscriptions: {
    id_robot: ObjectId;
    read?: string[];
    write?: string[][];
    wrtc_connection_state?: string;
    wrtc_connection_method?: string;
    wrtc_connection_ip?: string;
  }[];

  static connectedApps: App[] = [];

  constructor(idInstance?: string) {
    this.idApp = new ObjectId();
    //generates new instance id if undefined
    this.idInstance = new ObjectId(idInstance);
    this.filesSecret = new ObjectId();
  }

  static FindConnected(idInstance: ObjectId): App | null {
    for (let i = 0; i < App.connectedApps.length; i++) {
      if (App.connectedApps[i].idInstance.equals(idInstance)) {
        return App.connectedApps[i];
      }
    }

    return null;
  }

  public addToConnected() {
    if (App.connectedApps.indexOf(this) == -1) {
      App.connectedApps.push(this);
    }
  }

  public removeFromConnected() {
    let index = App.connectedApps.indexOf(this);
    this.servedMsgDefs = []; // reset
    if (index != -1) {
      App.connectedApps.splice(index, 1);
    }
  }

  public subscribeRobot(
    idRobot: ObjectId,
    read?: string[],
    write?: string[][],
  ) {
    for (let i = 0; i < this.robotSubscriptions.length; i++) {
      if (this.robotSubscriptions[i].id_robot.equals(idRobot)) {
        this.robotSubscriptions[i].read = read;
        this.robotSubscriptions[i].write = write;
        return;
      }
    }
    this.robotSubscriptions.push({
      id_robot: idRobot,
      read: read,
      write: write,
    });
  }

  public addToRobotSubscriptions(
    idRobot: ObjectId,
    read?: string[] | null,
    write?: string[][],
  ) {
    for (let i = 0; i < this.robotSubscriptions.length; i++) {
      if (this.robotSubscriptions[i].id_robot.equals(idRobot)) {
        if (read) {
          read.forEach((id_src) => {
            if (this.robotSubscriptions[i].read?.indexOf(id_src) === -1)
              this.robotSubscriptions[i].read?.push(id_src);
          });
        }
        if (write) {
          write.forEach((id_src) => {
            if (this.robotSubscriptions[i].write?.indexOf(id_src) === -1)
              this.robotSubscriptions[i].write?.push(id_src);
          });
        }
        return;
      }
    }
  }

  public removeFromRobotSubscriptions(
    idRobot: ObjectId,
    read?: string[],
    write?: string[],
  ) {
    for (let i = 0; i < this.robotSubscriptions.length; i++) {
      if (this.robotSubscriptions[i].id_robot.equals(idRobot)) {
        if (read) {
          read.forEach((id_src) => {
            let p = this.robotSubscriptions[i].read?.indexOf(id_src);
            if (p !== undefined && p !== -1) {
              this.robotSubscriptions[i].read?.splice(p, 1);
            }
          });
        }
        if (write) {
          write.forEach((id_src) => {
            for (
              let i = 0;
              i < (this.robotSubscriptions[i].write?.length ?? -1);
              i++
            ) {
              const write = this.robotSubscriptions[i].write;
              if (write && write[i][0] == id_src) {
                write.splice(i, 1);
                i--;
              }
            }
          });
        }
        return;
      }
    }
  }

  public getRobotSubscription(idRobot: ObjectId): any {
    for (let i = 0; i < this.robotSubscriptions.length; i++) {
      if (this.robotSubscriptions[i].id_robot.equals(idRobot)) {
        return this.robotSubscriptions[i];
      }
    }
    return false;
  }
}
