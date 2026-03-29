/**
 * RouterOS API client for MikroTik.
 *
 * Implements the MikroTik binary API protocol over TCP (port 8728) or TLS (port 8729).
 * Used to push firewall bans (address-list entries) and test connectivity.
 *
 * Protocol reference: https://help.mikrotik.com/docs/display/ROS/API
 *
 * Word encoding:
 *   len < 0x80:        1 byte  (len)
 *   len < 0x4000:      2 bytes (0x80 | hi, lo)
 *   len < 0x200000:    3 bytes (0xC0 | hi, mid, lo)
 *   len < 0x10000000:  4 bytes (0xE0 | b3, b2, b1, b0)
 */

import net from 'net';
import tls from 'tls';
import crypto from 'crypto';
import { logger } from '../../utils/logger';

// ── Word-length encoding/decoding ───────────────────────────────────────────

function encodeLength(len: number): Buffer {
  if (len < 0x80) {
    return Buffer.from([len]);
  } else if (len < 0x4000) {
    return Buffer.from([0x80 | ((len >> 8) & 0x3f), len & 0xff]);
  } else if (len < 0x200000) {
    return Buffer.from([0xc0 | ((len >> 16) & 0x1f), (len >> 8) & 0xff, len & 0xff]);
  } else {
    return Buffer.from([
      0xe0 | ((len >> 24) & 0x0f),
      (len >> 16) & 0xff,
      (len >> 8) & 0xff,
      len & 0xff,
    ]);
  }
}

function encodeWord(word: string): Buffer {
  const data = Buffer.from(word, 'utf-8');
  return Buffer.concat([encodeLength(data.length), data]);
}

function encodeSentence(words: string[]): Buffer {
  const parts = words.map(encodeWord);
  // Sentence ends with a zero-length word
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

// ── Response reading ────────────────────────────────────────────────────────

interface ReadState {
  buffer: Buffer;
}

function readLength(state: ReadState): number | null {
  if (state.buffer.length === 0) return null;
  const b0 = state.buffer[0];
  if ((b0 & 0x80) === 0) {
    state.buffer = state.buffer.subarray(1);
    return b0;
  } else if ((b0 & 0xc0) === 0x80) {
    if (state.buffer.length < 2) return null;
    const len = ((b0 & 0x3f) << 8) | state.buffer[1];
    state.buffer = state.buffer.subarray(2);
    return len;
  } else if ((b0 & 0xe0) === 0xc0) {
    if (state.buffer.length < 3) return null;
    const len = ((b0 & 0x1f) << 16) | (state.buffer[1] << 8) | state.buffer[2];
    state.buffer = state.buffer.subarray(3);
    return len;
  } else if ((b0 & 0xf0) === 0xe0) {
    if (state.buffer.length < 4) return null;
    const len = ((b0 & 0x0f) << 24) | (state.buffer[1] << 16) | (state.buffer[2] << 8) | state.buffer[3];
    state.buffer = state.buffer.subarray(4);
    return len;
  }
  return null;
}

function readSentence(state: ReadState): string[] | null {
  const words: string[] = [];
  const saved = Buffer.from(state.buffer);
  while (true) {
    const len = readLength(state);
    if (len === null) {
      state.buffer = saved;
      return null; // Need more data
    }
    if (len === 0) return words; // End of sentence
    if (state.buffer.length < len) {
      state.buffer = saved;
      return null;
    }
    words.push(state.buffer.subarray(0, len).toString('utf-8'));
    state.buffer = state.buffer.subarray(len);
  }
}

// ── Client class ────────────────────────────────────────────────────────────

export interface RouterOSConfig {
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  password: string;
}

export class RouterOSClient {
  private config: RouterOSConfig;
  private socket: net.Socket | tls.TLSSocket | null = null;
  private state: ReadState = { buffer: Buffer.alloc(0) };
  private pendingResolve: ((sentences: string[][]) => void) | null = null;
  private sentences: string[][] = [];

  constructor(config: RouterOSConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.close();
        reject(new Error('Connection timeout (10s)'));
      }, 10_000);

      const onConnect = () => {
        clearTimeout(timeout);
        this.setupDataHandler();
        resolve();
      };

      if (this.config.useTls) {
        this.socket = tls.connect(
          { host: this.config.host, port: this.config.port, rejectUnauthorized: false },
          onConnect,
        );
      } else {
        this.socket = net.createConnection(this.config.port, this.config.host, onConnect);
      }

      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private setupDataHandler(): void {
    this.socket?.on('data', (chunk) => {
      this.state.buffer = Buffer.concat([this.state.buffer, chunk]);
      while (true) {
        const sentence = readSentence(this.state);
        if (!sentence) break;
        this.sentences.push(sentence);
        // Check if this is a terminal sentence (!done, !trap, !fatal)
        if (sentence.length > 0 && (sentence[0] === '!done' || sentence[0] === '!trap' || sentence[0] === '!fatal')) {
          if (this.pendingResolve) {
            const resolve = this.pendingResolve;
            this.pendingResolve = null;
            const result = [...this.sentences];
            this.sentences = [];
            resolve(result);
          }
        }
      }
    });
  }

  private async sendAndWait(words: string[]): Promise<string[][]> {
    if (!this.socket) throw new Error('Not connected');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResolve = null;
        reject(new Error('Command timeout (15s)'));
      }, 15_000);

      this.sentences = [];
      this.pendingResolve = (result) => {
        clearTimeout(timeout);
        resolve(result);
      };

      this.socket!.write(encodeSentence(words));
    });
  }

  async login(): Promise<void> {
    // RouterOS 6.43+ plain-text login
    const result = await this.sendAndWait([
      '/login',
      `=name=${this.config.username}`,
      `=password=${this.config.password}`,
    ]);
    const reply = result[result.length - 1];
    if (!reply || reply[0] !== '!done') {
      // Check for challenge-response (RouterOS <6.43)
      if (reply && reply[0] === '!done' && reply.length > 1) {
        const retAttr = reply.find(w => w.startsWith('=ret='));
        if (retAttr) {
          const challenge = retAttr.slice(5);
          await this.loginChallenge(challenge);
          return;
        }
      }
      const trapMsg = result.find(s => s[0] === '!trap')?.find(w => w.startsWith('=message='));
      throw new Error(`Login failed: ${trapMsg?.slice(9) || 'unknown error'}`);
    }

    // Check if we got a challenge (pre-6.43)
    if (reply.length > 1) {
      const retAttr = reply.find(w => w.startsWith('=ret='));
      if (retAttr) {
        await this.loginChallenge(retAttr.slice(5));
      }
    }
  }

  private async loginChallenge(challenge: string): Promise<void> {
    // MD5 challenge-response for RouterOS <6.43
    const challengeBuf = Buffer.from(challenge, 'hex');
    const md5 = crypto.createHash('md5');
    md5.update(Buffer.from([0])); // null byte
    md5.update(this.config.password);
    md5.update(challengeBuf);
    const hash = '00' + md5.digest('hex');

    const result = await this.sendAndWait([
      '/login',
      `=name=${this.config.username}`,
      `=response=${hash}`,
    ]);
    const reply = result[result.length - 1];
    if (!reply || reply[0] !== '!done') {
      throw new Error('Challenge login failed');
    }
  }

  async testConnection(): Promise<string> {
    const result = await this.sendAndWait(['/system/identity/print']);
    const replyData = result.find(s => s[0] === '!re');
    const nameAttr = replyData?.find(w => w.startsWith('=name='));
    return nameAttr?.slice(6) || 'unknown';
  }

  async banIP(ip: string, listName: string, comment = 'Obliguard auto-ban'): Promise<void> {
    const result = await this.sendAndWait([
      '/ip/firewall/address-list/add',
      `=list=${listName}`,
      `=address=${ip}`,
      `=comment=${comment}`,
    ]);
    // Ignore "already have such entry" errors
    const trap = result.find(s => s[0] === '!trap');
    if (trap) {
      const msg = trap.find(w => w.startsWith('=message='))?.slice(9) || '';
      if (!msg.includes('already have')) {
        throw new Error(`banIP failed: ${msg}`);
      }
    }
  }

  async unbanIP(ip: string, listName: string): Promise<void> {
    // Find the entry ID first
    const result = await this.sendAndWait([
      '/ip/firewall/address-list/print',
      `?list=${listName}`,
      `?address=${ip}`,
    ]);

    for (const sentence of result) {
      if (sentence[0] !== '!re') continue;
      const idAttr = sentence.find(w => w.startsWith('=.id='));
      if (idAttr) {
        await this.sendAndWait([
          '/ip/firewall/address-list/remove',
          `=.id=${idAttr.slice(5)}`,
        ]);
      }
    }
  }

  async getBannedIPs(listName: string): Promise<string[]> {
    const result = await this.sendAndWait([
      '/ip/firewall/address-list/print',
      `?list=${listName}`,
    ]);

    const ips: string[] = [];
    for (const sentence of result) {
      if (sentence[0] !== '!re') continue;
      const addrAttr = sentence.find(w => w.startsWith('=address='));
      if (addrAttr) ips.push(addrAttr.slice(9));
    }
    return ips;
  }

  /**
   * Fetch recent log entries. Returns an array of { id, time, topics, message }.
   * RouterOS /log/print returns entries with attributes:
   *   =.id=  =time=  =topics=  =message=
   */
  async getLogEntries(topics?: string): Promise<Array<{ id: string; time: string; topics: string; message: string }>> {
    const cmd = ['/log/print'];
    if (topics) {
      // Filter by topic (e.g., "system" to get auth-related entries)
      cmd.push(`?topics=${topics}`);
    }
    const result = await this.sendAndWait(cmd);

    const entries: Array<{ id: string; time: string; topics: string; message: string }> = [];
    for (const sentence of result) {
      if (sentence[0] !== '!re') continue;
      const entry = { id: '', time: '', topics: '', message: '' };
      for (const word of sentence) {
        if (word.startsWith('=.id=')) entry.id = word.slice(5);
        else if (word.startsWith('=time=')) entry.time = word.slice(6);
        else if (word.startsWith('=topics=')) entry.topics = word.slice(8);
        else if (word.startsWith('=message=')) entry.message = word.slice(9);
      }
      if (entry.message) entries.push(entry);
    }
    return entries;
  }

  /** Send a raw command and return all response sentences (for debugging). */
  async sendCommand(words: string[]): Promise<string[][]> {
    return this.sendAndWait(words);
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
    this.pendingResolve = null;
    this.sentences = [];
    this.state.buffer = Buffer.alloc(0);
  }
}

/**
 * Create a connected and authenticated RouterOS client.
 */
export async function createRouterOSClient(cfg: RouterOSConfig): Promise<RouterOSClient> {
  const client = new RouterOSClient(cfg);
  await client.connect();
  await client.login();
  return client;
}
