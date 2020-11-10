import { EventEmitter } from "events";
import { Logger } from "pino";
import {
  IClient,
  ISession,
  KeyParams,
  SessionTypes,
  SettingTypes,
  SubscriptionEvent,
} from "@walletconnect/types";
import {
  deriveSharedKey,
  generateKeyPair,
  generateRandomBytes32,
  isSessionFailed,
  mapEntries,
  sha256,
  formatLoggerContext,
  isSessionResponded,
  isSubscriptionUpdatedEvent,
  generateSettledSetting,
  generateCaip25ProposalSetting,
  handleSettledSettingStateUpdate,
} from "@walletconnect/utils";
import {
  JsonRpcPayload,
  JsonRpcRequest,
  formatJsonRpcError,
  formatJsonRpcRequest,
  formatJsonRpcResult,
  isJsonRpcRequest,
  JsonRpcResponse,
  isJsonRpcError,
} from "rpc-json-utils";

import { Subscription } from "./subscription";
import {
  SESSION_CONTEXT,
  SESSION_EVENTS,
  SESSION_JSONRPC,
  SESSION_REASONS,
  SESSION_STATUS,
  SUBSCRIPTION_EVENTS,
  SETTLED_SESSION_JSONRPC,
  SESSION_SIGNAL_TYPE_CONNECTION,
  SETTLED_CONNECTION_JSONRPC,
} from "../constants";

export class Session extends ISession {
  public pending: Subscription<SessionTypes.Pending>;
  public settled: Subscription<SessionTypes.Settled>;

  public events = new EventEmitter();

  protected context: string = SESSION_CONTEXT;

  constructor(public client: IClient, public logger: Logger) {
    super(client, logger);
    this.logger = logger.child({
      context: formatLoggerContext(logger, this.context),
    });
    this.pending = new Subscription<SessionTypes.Pending>(
      client,
      this.logger,
      SESSION_STATUS.pending,
      true,
    );
    this.settled = new Subscription<SessionTypes.Settled>(
      client,
      this.logger,
      SESSION_STATUS.settled,
      true,
    );
    this.registerEventListeners();
  }

  public async init(): Promise<void> {
    this.logger.trace(`Initialized`);
    await this.pending.init();
    await this.settled.init();
  }

  public async get(topic: string): Promise<SessionTypes.Settled> {
    return this.settled.get(topic);
  }

  public async send(topic: string, payload: JsonRpcPayload): Promise<void> {
    const session = await this.settled.get(topic);
    const encryptKeys: KeyParams = {
      sharedKey: session.sharedKey,
      publicKey: session.keyPair.publicKey,
    };
    this.client.relay.publish(session.topic, payload, { relay: session.relay, encryptKeys });
  }

  get length(): number {
    return this.settled.length;
  }

  get entries(): Record<string, SessionTypes.Settled> {
    return mapEntries(this.settled.entries, x => x.data);
  }

  public async create(params: SessionTypes.CreateParams): Promise<SessionTypes.Settled> {
    this.logger.info(`Create Session`);
    this.logger.trace({ type: "method", method: "create", params });
    return new Promise(async (resolve, reject) => {
      const pending = await this.propose(params);
      this.pending.on(
        SUBSCRIPTION_EVENTS.updated,
        async (updatedEvent: SubscriptionEvent.Updated<SessionTypes.Pending>) => {
          if (pending.topic !== updatedEvent.data.topic) return;
          if (isSessionResponded(updatedEvent.data)) {
            const outcome = updatedEvent.data.outcome;
            if (isSessionFailed(outcome)) {
              await this.pending.delete(pending.topic, outcome.reason);
              reject(new Error(outcome.reason));
            } else {
              const connection = await this.settled.get(outcome.topic);
              await this.pending.delete(pending.topic, SESSION_REASONS.settled);
              resolve(connection);
            }
          }
        },
      );
    });
  }

  public async respond(params: SessionTypes.RespondParams): Promise<SessionTypes.Pending> {
    this.logger.info(`Respond Session`);
    this.logger.trace({ type: "method", method: "respond", params });
    const { approved, metadata, proposal } = params;
    const { relay } = proposal;
    const keyPair = generateKeyPair();
    const connection = await this.client.connection.get(proposal.signal.params.topic);
    const decryptKeys: KeyParams = {
      sharedKey: connection.sharedKey,
      publicKey: connection.peer.publicKey,
    };
    if (approved) {
      try {
        const responder: SessionTypes.Participant = {
          publicKey: keyPair.publicKey,
          metadata,
        };
        const setting = generateSettledSetting({
          proposal: proposal.setting,
          proposer: proposal.proposer,
          responder,
          state: params.state,
        });
        const session = await this.settle({
          relay,
          keyPair,
          peer: proposal.proposer,
          setting,
        });
        const outcome: SessionTypes.Outcome = {
          topic: session.topic,
          relay: session.relay,
          setting: session.setting,
          responder,
        };
        const pending: SessionTypes.Pending = {
          status: SESSION_STATUS.responded,
          topic: proposal.topic,
          relay: proposal.relay,
          keyPair,
          proposal,
          outcome,
        };
        await this.pending.set(pending.topic, pending, { relay: pending.relay, decryptKeys });
        return pending;
      } catch (e) {
        const reason = e.message;
        const outcome: SessionTypes.Outcome = { reason };
        const pending: SessionTypes.Pending = {
          status: SESSION_STATUS.responded,
          topic: proposal.topic,
          relay: proposal.relay,
          keyPair,
          proposal,
          outcome,
        };
        await this.pending.set(pending.topic, pending, { relay: pending.relay, decryptKeys });
        return pending;
      }
    } else {
      const outcome = { reason: SESSION_REASONS.not_approved };
      const pending: SessionTypes.Pending = {
        status: SESSION_STATUS.responded,
        topic: proposal.topic,
        relay: proposal.relay,
        keyPair,
        proposal,
        outcome,
      };
      await this.pending.set(pending.topic, pending, { relay: pending.relay, decryptKeys });
      return pending;
    }
  }

  public async update(params: SessionTypes.UpdateParams): Promise<SessionTypes.Settled> {
    this.logger.info(`Update Session`);
    this.logger.trace({ type: "method", method: "update", params });
    const session = await this.settled.get(params.topic);
    const update = await this.handleUpdate(session, params);
    const request = formatJsonRpcRequest(SESSION_JSONRPC.update, update);
    this.send(session.topic, request);
    return session;
  }

  public async delete(params: SessionTypes.DeleteParams): Promise<void> {
    this.logger.info(`Delete Session`);
    this.logger.trace({ type: "method", method: "delete", params });
    this.settled.delete(params.topic, params.reason);
  }

  public on(event: string, listener: any): void {
    this.events.on(event, listener);
  }

  public once(event: string, listener: any): void {
    this.events.once(event, listener);
  }

  public off(event: string, listener: any): void {
    this.events.off(event, listener);
  }

  // ---------- Protected ----------------------------------------------- //

  protected async propose(params: SessionTypes.ProposeParams): Promise<SessionTypes.Pending> {
    this.logger.info(`Propose Session`);
    this.logger.trace({ type: "method", method: "propose", params });
    if (params.signal.type !== SESSION_SIGNAL_TYPE_CONNECTION)
      throw new Error(`Session proposal signal unsupported`);
    const connection = await this.client.connection.settled.get(params.signal.params.topic);
    const signal: SessionTypes.SignalConnection = {
      type: SESSION_SIGNAL_TYPE_CONNECTION,
      params: { topic: connection.topic },
    };
    const decryptKeys: KeyParams = {
      sharedKey: connection.sharedKey,
      publicKey: connection.peer.publicKey,
    };
    const topic = generateRandomBytes32();
    const keyPair = generateKeyPair();
    const proposer: SessionTypes.Participant = {
      publicKey: keyPair.publicKey,
      metadata: params.metadata,
    };
    const setting = {
      ...params.setting,
      methods: { ...SETTLED_CONNECTION_JSONRPC, ...params.setting.methods },
    };
    const proposal: SessionTypes.Proposal = {
      topic,
      relay: params.relay,
      proposer,
      signal,
      setting,
    };
    const pending: SessionTypes.Pending = {
      status: SESSION_STATUS.proposed,
      topic: proposal.topic,
      relay: proposal.relay,
      keyPair,
      proposal,
    };
    await this.pending.set(pending.topic, pending, { relay: pending.relay, decryptKeys });
    const request = formatJsonRpcRequest(SESSION_JSONRPC.propose, proposal);
    await this.client.connection.send(signal.params.topic, request);
    return pending;
  }

  protected async settle(params: SessionTypes.SettleParams): Promise<SessionTypes.Settled> {
    this.logger.info(`Settle Session`);
    this.logger.trace({ type: "method", method: "settle", params });
    const sharedKey = deriveSharedKey(params.keyPair.privateKey, params.peer.publicKey);
    const topic = await sha256(sharedKey);
    const session: SessionTypes.Settled = {
      relay: params.relay,
      topic,
      sharedKey,
      keyPair: params.keyPair,
      peer: params.peer,
      setting: params.setting,
    };
    const decryptKeys: KeyParams = {
      sharedKey: session.sharedKey,
      publicKey: session.peer.publicKey,
    };
    await this.settled.set(session.topic, session, { relay: session.relay, decryptKeys });
    return session;
  }

  protected async onResponse(payloadEvent: SubscriptionEvent.Payload): Promise<void> {
    const { topic, payload } = payloadEvent;
    this.logger.info(`Receiving Session response`);
    this.logger.trace({ type: "method", method: "onResponse", topic, payload });
    const request = payload as JsonRpcRequest<SessionTypes.Outcome>;
    const pending = await this.pending.get(topic);
    const connection = await this.client.connection.get(pending.proposal.signal.params.topic);
    const encryptKeys: KeyParams = {
      sharedKey: connection.sharedKey,
      publicKey: connection.keyPair.publicKey,
    };
    let errorMessage: string | undefined;
    if (!isSessionFailed(request.params)) {
      try {
        const session = await this.settle({
          relay: pending.relay,
          keyPair: pending.keyPair,
          peer: request.params.responder,
          setting: request.params.setting,
        });
        await this.pending.update(topic, {
          status: SESSION_STATUS.responded,
          outcome: {
            topic: session.topic,
            relay: session.relay,
            setting: session.setting,
            responder: session.peer,
          },
        });
      } catch (e) {
        this.logger.error(e);
        errorMessage = e.message;
        await this.pending.update(topic, {
          status: SESSION_STATUS.responded,
          outcome: { reason: e.message },
        });
      }
      const response =
        typeof errorMessage === "undefined"
          ? formatJsonRpcResult(request.id, true)
          : formatJsonRpcError(request.id, errorMessage);
      this.client.relay.publish(pending.topic, response, { relay: pending.relay, encryptKeys });
    } else {
      this.logger.error(request.params.reason);
      await this.pending.update(topic, {
        status: SESSION_STATUS.responded,
        outcome: { reason: request.params.reason },
      });
    }
  }

  protected async onAcknowledge(payloadEvent: SubscriptionEvent.Payload): Promise<void> {
    const { topic, payload } = payloadEvent;
    this.logger.info(`Receiving Session acknowledge`);
    this.logger.trace({ type: "method", method: "onAcknowledge", topic, payload });
    const response = payload as JsonRpcResponse;
    const pending = await this.pending.get(topic);
    if (!isSessionResponded(pending)) return;
    if (isJsonRpcError(response) && !isSessionFailed(pending.outcome)) {
      await this.settled.delete(pending.outcome.topic, response.error.message);
    }
    await this.pending.delete(payloadEvent.topic, SESSION_REASONS.acknowledged);
  }

  protected async onMessage(payloadEvent: SubscriptionEvent.Payload): Promise<void> {
    const { topic, payload } = payloadEvent;
    this.logger.info(`Receiving Session message`);
    this.logger.trace({ type: "method", method: "onMessage", topic, payload });
    if (isJsonRpcRequest(payload)) {
      const request = payload as JsonRpcRequest;
      const session = await this.settled.get(payloadEvent.topic);
      if (!session.setting.methods.includes(request.method)) {
        const errorMessage = `Unauthorized JSON-RPC Method Requested: ${request.method}`;
        this.logger.error(errorMessage);
        const response = formatJsonRpcError(request.id, errorMessage);
        this.send(session.topic, response);
      }
      switch (request.method) {
        case SESSION_JSONRPC.update:
          await this.onUpdate(payloadEvent);
          break;
        case SESSION_JSONRPC.delete:
          await this.settled.delete(session.topic, request.params.reason);
          break;
        default:
          this.events.emit(SESSION_EVENTS.payload, payloadEvent.payload);
          break;
      }
    } else {
      this.events.emit(SESSION_EVENTS.payload, payloadEvent.payload);
    }
  }

  protected async onUpdate(payloadEvent: SubscriptionEvent.Payload): Promise<void> {
    const { topic, payload } = payloadEvent;
    this.logger.debug(`Receiving Session update`);
    this.logger.trace({ type: "method", method: "onUpdate", topic, payload });
    const request = payloadEvent.payload as JsonRpcRequest;
    const session = await this.settled.get(payloadEvent.topic);
    try {
      await this.handleUpdate(session, request.params, true);
      const response = formatJsonRpcResult(request.id, true);
      this.send(session.topic, response);
    } catch (e) {
      this.logger.error(e);
      const response = formatJsonRpcError(request.id, e.message);
      this.send(session.topic, response);
    }
  }

  protected async handleUpdate(
    session: SessionTypes.Settled,
    params: SessionTypes.UpdateParams,
    fromPeer?: boolean,
  ): Promise<SessionTypes.Update> {
    let update: SessionTypes.Update;
    if (typeof params.state !== "undefined") {
      const publicKey = fromPeer ? session.peer.publicKey : session.keyPair.publicKey;
      const state = handleSettledSettingStateUpdate({
        participant: { publicKey },
        settled: session.setting,
        update: params.state,
      });
      update = { state };
    } else if (typeof params.metadata !== "undefined") {
      const metadata = params.metadata as SessionTypes.Metadata;
      if (fromPeer) {
        session.peer.metadata = metadata;
      }
      update = { metadata };
    } else {
      const errorMessage = `Invalid ${this.context} update request params`;
      this.logger.error(errorMessage);
      throw new Error(errorMessage);
    }
    await this.settled.update(session.topic, session);
    return update;
  }

  // ---------- Private ----------------------------------------------- //

  private async onPendingPayloadEvent(event: SubscriptionEvent.Payload) {
    if (isJsonRpcRequest(event.payload)) {
      if (event.payload.method === SESSION_JSONRPC.respond) {
        this.onResponse(event);
      }
    } else {
      this.onAcknowledge(event);
    }
  }
  private async onPendingStatusEvent(
    event:
      | SubscriptionEvent.Created<SessionTypes.Pending>
      | SubscriptionEvent.Updated<SessionTypes.Pending>,
  ) {
    const pending = event.data;
    if (isSessionResponded(pending)) {
      this.events.emit(SESSION_EVENTS.responded, pending);
      if (!isSubscriptionUpdatedEvent(event)) {
        const connection = await this.client.connection.get(pending.proposal.signal.params.topic);
        const encryptKeys: KeyParams = {
          sharedKey: connection.sharedKey,
          publicKey: connection.keyPair.publicKey,
        };
        const request = formatJsonRpcRequest(SESSION_JSONRPC.respond, pending.outcome);
        this.client.relay.publish(pending.topic, request, { relay: pending.relay, encryptKeys });
      }
    } else {
      this.events.emit(SESSION_EVENTS.proposed, pending);
    }
  }

  private registerEventListeners(): void {
    // Pending Subscription Events
    this.pending.on(SUBSCRIPTION_EVENTS.payload, (payloadEvent: SubscriptionEvent.Payload) =>
      this.onPendingPayloadEvent(payloadEvent),
    );
    this.pending.on(
      SUBSCRIPTION_EVENTS.created,
      (createdEvent: SubscriptionEvent.Created<SessionTypes.Pending>) =>
        this.onPendingStatusEvent(createdEvent),
    );
    this.pending.on(
      SUBSCRIPTION_EVENTS.updated,
      (updatedEvent: SubscriptionEvent.Updated<SessionTypes.Pending>) =>
        this.onPendingStatusEvent(updatedEvent),
    );
    // Settled Subscription Events
    this.settled.on(SUBSCRIPTION_EVENTS.payload, (payloadEvent: SubscriptionEvent.Payload) =>
      this.onMessage(payloadEvent),
    );
    this.settled.on(
      SUBSCRIPTION_EVENTS.created,
      (createdEvent: SubscriptionEvent.Created<SessionTypes.Settled>) => {
        const session = createdEvent.data;
        this.events.emit(SESSION_EVENTS.settled, session);
      },
    );
    this.settled.on(
      SUBSCRIPTION_EVENTS.updated,
      (updatedEvent: SubscriptionEvent.Updated<SessionTypes.Settled>) => {
        const session = updatedEvent.data;
        this.events.emit(SESSION_EVENTS.updated, session);
      },
    );
    this.settled.on(
      SUBSCRIPTION_EVENTS.deleted,
      (deletedEvent: SubscriptionEvent.Deleted<SessionTypes.Settled>) => {
        const session = deletedEvent.data;
        this.events.emit(SESSION_EVENTS.deleted, session);
        const request = formatJsonRpcRequest(SESSION_JSONRPC.delete, {
          reason: deletedEvent.reason,
        });
        this.send(session.topic, request);
      },
    );
  }
}
