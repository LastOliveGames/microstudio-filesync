import WebSocket from 'ws';

export default class MicroStudio {
  #requestId = 0;
  #requests = new Map();
  #lastPongTimestamp = Date.now();
  #onEvent;
  ready;
  #resolveReady;

  constructor(token, onEvent) {
    this.#onEvent = onEvent;
    this.#createWebSocket(token);
  }

  #createWebSocket(token) {
    this.ws = new WebSocket('wss://microstudio.dev');
    this.ready = new Promise(resolve => {
      this.#resolveReady = resolve;
    })

    this.ws.on('open', async () => {
      try {
        await this.request('token', {token}, 'token_valid');
        console.log('Authenticated');
        this.#resolveReady();
        setInterval(async () => {
          if (this.#lastPongTimestamp + 20000 < Date.now()) {
            console.error('Did not receive timely microStudio server heartbeat');
            process.exit(1);
          }
          this.call('ping');
        }, 10000);
      } catch (e) {
        console.error(e.trace);
        process.exit(1);
      }
    });

    this.ws.on('message', rawMessage => {
      try {
        const message = JSON.parse(rawMessage);
        if (message.name === 'pong') {
          this.#lastPongTimestamp = Date.now();
          return;
        }
        if (message.name === 'error') {
          console.error('Communication error:', message.error);
          process.exit(1);
        }
        debug('<', rawMessage.toString());
        if ('request_id' in message) {
          const entry = this.#requests.get(message.request_id);
          if (entry) {
            if (entry.responseName !== message.name) {
              console.error(`Received unexpected response to ${entry.action}:`);
              console.error(message);
              process.exit(1);
            }
            entry.resolve(message);
          }
        } else if (this.#onEvent) {
          this.#onEvent(message);
        }
      } catch (e) {
        console.error(e.trace);
        process.exit(1);
      }
    });

    this.ws.on('close', () => {
      console.warn('microStudio server dropped connection');
      process.exit(0);
    });

    this.ws.on('error', error => {
      console.error('WebSocket error:', error);
      process.exit(1);
    });
  }

  async call(action, params) {
    const request_id = this.#requestId++;
    debug('>', JSON.stringify({name: action, ...params, request_id}));
    this.ws.send(JSON.stringify({name: action, request_id}));
  }

  async request(action, params, responseName) {
    responseName ??= action;
    const request_id = this.#requestId++;
    const promise = new Promise((resolve, reject) => {
      this.#requests.set(request_id, {resolve, reject, action, responseName});
    });
    debug('>', JSON.stringify({name: action, ...params, request_id}));
    try {
      this.ws.send(JSON.stringify({name: action, ...params, request_id}));
      const reply = await promise;
      delete reply.request_id;
      return reply;
    } finally {
      this.#requests.delete(request_id);
    }
  }
}

function debug(...args) {
  if (process.env.DEBUG) console.log(...args);
}
