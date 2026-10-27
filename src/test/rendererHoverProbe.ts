// Opt-in diagnostics for the test-owned VS Code renderer. No user browser or
// installed extension settings are changed. Requires a loopback debugging port.
interface RendererTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface RendererStamp {
  unixMs: number;
  monotonicMs: number;
}

export interface RendererHoverObservation {
  armed: RendererStamp;
  firstVisible?: RendererStamp & { text: string };
  firstExpected?: RendererStamp & { text: string };
  firstAnimationFrame?: RendererStamp;
  secondAnimationFrame?: RendererStamp;
}

export interface RendererEditorObservation {
  documentFocused: boolean;
  activeElement: { tag: string; role: string | null; label: string | null; classes: string; inCodeEditor: boolean; readOnly: string | null } | null;
  editors: Array<{ focusedClass: boolean; containsActiveElement: boolean; label: string | null }>;
  allEditors: Array<{ classes: string; containsActiveElement: boolean; label: string | null }>;
  hovers: Array<{ text: string; cards: string[] }>;
}

export interface RendererCodeLinesObservation extends RendererStamp {
  lines: Array<{
    text: string;
    spans: Array<{ text: string; classes: string; color: string; background: string }>;
  }>;
}

export class RendererHoverProbe {
  private sequence = 0;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();

  private constructor(private readonly socket: WebSocket, readonly target: RendererTarget) {
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown };
      if (message.id === undefined) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    socket.addEventListener('close', () => this.rejectPending(new Error('Renderer connection closed')));
    socket.addEventListener('error', () => this.rejectPending(new Error('Renderer connection failed')));
  }

  static async connect(port: number): Promise<RendererHoverProbe> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid renderer port');
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Renderer discovery failed: ${response.status}`);
    const targets = await response.json() as RendererTarget[];
    const matches = targets.filter(target => target.type === 'page'
      && target.url.startsWith('vscode-file://') && target.url.includes('workbench')
      && target.webSocketDebuggerUrl);
    if (matches.length !== 1) throw new Error(`Expected one test-owned workbench, found ${matches.length}`);
    const target = matches[0];
    const url = new URL(target.webSocketDebuggerUrl!);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error('Non-loopback renderer');
    const socket = new WebSocket(url);
    const probe = new RendererHoverProbe(socket, target);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Renderer connection timed out')); }, 5_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Renderer connection failed')); }, { once: true });
    });
    return probe;
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }

  private call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 5_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  private async evaluate<T>(expression: string): Promise<T> {
    const result = await this.call<{ result: { value: T }; exceptionDetails?: unknown }>(
      'Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }

  clock(): Promise<RendererStamp> {
    return this.evaluate('({ unixMs: Date.now(), monotonicMs: performance.now() })');
  }

  async arm(expectedText: string[]): Promise<void> {
    await this.evaluate(`(() => {
      const key = '__djlsHoverRenderProbe';
      window[key]?.observer.disconnect();
      const stamp = () => ({ unixMs: Date.now(), monotonicMs: performance.now() });
      const state = { armed: stamp() };
      const expected = ${JSON.stringify(expectedText)};
      const check = () => {
        for (const node of document.querySelectorAll('.monaco-hover')) {
          const box = node.getBoundingClientRect(), style = getComputedStyle(node);
          if (!node.isConnected || !box.width || !box.height || style.display === 'none' || style.visibility === 'hidden') continue;
          const text = node.innerText.replace(/\\s+/g, ' ').trim();
          if (!text) continue;
          state.firstVisible ??= { ...stamp(), text };
          if (!state.firstExpected && expected.every(value => text.includes(value))) {
            state.firstExpected = { ...stamp(), text };
            requestAnimationFrame(() => {
              state.firstAnimationFrame = stamp();
              requestAnimationFrame(() => { state.secondAnimationFrame = stamp(); });
            });
          }
        }
      };
      state.observer = new MutationObserver(check);
      state.observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      window[key] = state;
      check();
      return true;
    })()`);
  }

  observation(): Promise<RendererHoverObservation> {
    return this.evaluate(`(() => { const { observer, ...value } = window.__djlsHoverRenderProbe; return value; })()`);
  }

  editorObservation(): Promise<RendererEditorObservation> {
    return this.evaluate(`(() => {
      const active = document.activeElement;
      const visible = node => {
        const box = node.getBoundingClientRect(), style = getComputedStyle(node);
        return node.isConnected && box.width > 0 && box.height > 0
          && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const text = node => node.innerText.replace(/\\s+/g, ' ').trim();
      return {
        documentFocused: document.hasFocus(),
        activeElement: active ? { tag: active.tagName, role: active.getAttribute('role'),
          label: active.getAttribute('aria-label'), classes: active.className,
          inCodeEditor: Boolean(active.closest('.editor-instance .monaco-editor')),
          readOnly: active.getAttribute('aria-readonly') } : null,
        editors: [...document.querySelectorAll('.editor-instance .monaco-editor')].filter(visible).map(node => ({
          focusedClass: node.classList.contains('focused'), containsActiveElement: node.contains(active),
          label: node.querySelector('textarea, [contenteditable="true"]')?.getAttribute('aria-label') ?? null,
        })),
        allEditors: [...document.querySelectorAll('.monaco-editor')].filter(visible).map(node => ({
          classes: node.className, containsActiveElement: node.contains(active),
          label: node.querySelector('[role="textbox"]')?.getAttribute('aria-label') ?? null,
        })),
        hovers: [...document.querySelectorAll('.monaco-hover')].filter(visible).map(node => ({
          text: text(node), cards: [...node.querySelectorAll('.hover-row')].map(text).filter(Boolean),
        })),
      };
    })()`);
  }

  codeLinesObservation(): Promise<RendererCodeLinesObservation> {
    // Inlay labels use dynamically generated classes. Observe the actual line
    // text and spans rather than assuming a stable, inlay-specific CSS class.
    return this.evaluate(`(() => {
      const text = node => node.innerText.replace(/\\s+/g, ' ').trim();
      const visible = node => {
        const box = node.getBoundingClientRect(), style = getComputedStyle(node);
        const editor = node.closest('.monaco-editor').getBoundingClientRect();
        return node.isConnected && box.width > 0 && box.height > 0
          && box.bottom > editor.top && box.top < editor.bottom
          && style.display !== 'none' && style.visibility !== 'hidden';
      };
      return { unixMs: Date.now(), monotonicMs: performance.now(),
        lines: [...document.querySelectorAll('.editor-instance .monaco-editor .view-lines .view-line')]
          .filter(visible).slice(0, 100).map(node => ({ text: text(node),
            spans: [...node.querySelectorAll('span')].filter(span => span.children.length === 0)
              .slice(0, 100).map(span => { const style = getComputedStyle(span); return {
                text: text(span), classes: span.className, color: style.color, background: style.backgroundColor,
              }; }),
          })),
      };
    })()`);
  }

  async screenshot(): Promise<Buffer> {
    const result = await this.call<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(result.data, 'base64');
  }

  async dispose(): Promise<void> {
    try { await this.evaluate('window.__djlsHoverRenderProbe?.observer.disconnect()'); }
    finally { this.socket.close(); this.rejectPending(new Error('Renderer probe disposed')); }
  }
}
