import {rpc} from "@cityofzion/neon-js";
import {ContractParamJson} from "@cityofzion/neon-core/lib/sc";

export class N3Helper {
    private readonly rpcAddress: string
    private readonly networkMagic: number

    constructor(rpcAddress: string, networkMagic: number) {
        this.rpcAddress = rpcAddress
        this.networkMagic = networkMagic
    }

    // TODO: the websocket didn't send the desired information
    getNotificationsFromTxId2 = async (txId: string): Promise<any> => {
        return new Promise((resolve, reject) => {
            new WebSocket(`wss://dora.coz.io/ws/v1/neo3/testnet/log/${txId}`).onmessage = function (event) {
                console.log(event.data);
                // this.close()
                // resolve(event.data)
            }
        })
    }

    getNotificationsFromTxId = async (txId: string) => {
        const rpcClient = new rpc.RPCClient(this.rpcAddress)

        // TODO: use Joe's websocket to create `await waitForTheNextBlock()` - http://54.227.25.52:9009/
        let appLog
        do {
            try {
                appLog = await rpcClient.getApplicationLog(txId)
            } catch (e) {
                await this.sleep(5000)
            }
        } while (!appLog)

        const allNotifications: {
            contract: string;
            eventname: string;
            state: ContractParamJson;
        }[] = []
        appLog.executions.forEach(e => {
            allNotifications.push(...e.notifications)
        })

        return allNotifications
    }

    private sleep = (time: number) => {
        return new Promise(resolve => {
            setTimeout(resolve, time)
        })
    }
}