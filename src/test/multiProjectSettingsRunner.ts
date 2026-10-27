/** Explicit VS Code host check for independent settings; no trust flags or timeout overrides. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {getActiveDaemonForTesting, getLanguageClientForTesting} from '../client/extension';

interface Observation {project: string; action: string; passed: boolean; elapsedMs: number; detail?: unknown; error?: string}
const observations: Observation[] = [];
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function until<T>(body: () => PromiseLike<T> | T, accepts: (value: T) => boolean, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  do {
    last = await body();
    if (accepts(last)) return last;
    await delay(150);
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

function labels(result?: vscode.CompletionList): string[] {
  return result?.items.map(item => typeof item.label === 'string' ? item.label : item.label.label) ?? [];
}

async function documentWith(root: string, name: string, text: string): Promise<vscode.TextDocument> {
  const uri = vscode.Uri.file(path.join(root, name, 'usage.py'));
  const document = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), 'from inventory.models import Item\n' + text + '\n');
  assert(await vscode.workspace.applyEdit(edit));
  await vscode.window.showTextDocument(document, {preview: false});
  return document;
}

function inside(document: vscode.TextDocument, text: string): vscode.Position {
  const offset = document.getText().lastIndexOf(text);
  assert(offset >= 0, text);
  return document.positionAt(offset + Math.max(1, text.length - 1));
}

async function check(project: string, action: string, body: () => Promise<unknown>): Promise<void> {
  const started = performance.now();
  try {
    const detail = await body();
    observations.push({project, action, passed: true, elapsedMs: performance.now() - started, detail});
  } catch (error) {
    observations.push({project, action, passed: false, elapsedMs: performance.now() - started, error: String(error)});
  }
}

export async function run(): Promise<void> {
  const output = process.env.DJLS_MULTI_HOST_REPORT;
  assert(output && path.isAbsolute(output), 'An owned output path is required');
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert(root && path.basename(root) === 'workspace', 'The runner only edits its prepared fixture');
  const persist = (status: string, extra = {}) => fs.writeFileSync(output, JSON.stringify({
    status, workspaceRoot: root, vscodeVersion: vscode.version, trusted: vscode.workspace.isTrusted,
    observations, ...extra,
  }, null, 2));
  persist('starting');
  try {
    await until(() => vscode.workspace.isTrusted, Boolean, 'Workspace needs explicit trust approval', 120_000);
    const pylance = vscode.extensions.getExtension('ms-python.vscode-pylance');
    const python = vscode.extensions.getExtension('ms-python.python');
    assert(pylance && python, 'Real Python and Pylance extensions are required for the diagnostic check');
    await python.activate();
    await pylance.activate();
    const extension = vscode.extensions.getExtension('newdlops.django-orm-intellisense');
    assert(extension);
    await extension.activate();
    const first = await documentWith(root, 'one', 'Item.objects.filter(only_one__gte=1)');
    const daemon = getActiveDaemonForTesting();
    assert(daemon);
    await daemon.ensureStarted(first.uri);
    await until(() => daemon.projectContexts, contexts => contexts.length === 2
      && contexts.every(context => context.runtime?.bootstrapStatus === 'ready'), 'Both settings registries must be ready');
    assert.equal(path.resolve(daemon.getState().workspaceRoot!), path.resolve(root));
    for (const project of ['one', 'two']) {
      const own = 'only_' + project, other = 'only_' + (project === 'one' ? 'two' : 'one');
      await check(project, 'lookup-completion', async () => {
        const document = await documentWith(root, project, 'Item.objects.filter(only_');
        const result = await vscode.commands.executeCommand<vscode.CompletionList>(
          'vscode.executeCompletionItemProvider', document.uri, inside(document, 'only_').translate(0, 1));
        const names = labels(result);
        assert(names.includes(own), names.join(', '));
        assert(!names.includes(other), names.join(', '));
        return names.filter(name => name.startsWith('only_'));
      });
      await check(project, 'member-completion', async () => {
        const document = await documentWith(root, project, 'item = Item.objects.first()\nitem.only_');
        const result = await vscode.commands.executeCommand<vscode.CompletionList>(
          'vscode.executeCompletionItemProvider', document.uri, inside(document, 'only_').translate(0, 1));
        assert(labels(result).includes(own), JSON.stringify(labels(result)));
        assert(!labels(result).includes(other));
        return labels(result).filter(name => name.startsWith('only_'));
      });
      await check(project, 'hover', async () => {
        const document = await documentWith(root, project, `Item.objects.filter(${own}__gte=1)`);
        const result = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, inside(document, own));
        const text = result?.flatMap(hover => hover.contents.map(item => typeof item === 'string' ? item : item.value)).join('\n') ?? '';
        assert(text.includes(own), text);
        assert(!text.includes(other), text);
        assert(text.includes('Base model: `inventory.Item`'), text);
        assert(!/project_[0-9a-f]{16}\./.test(text), text);
        return text;
      });
      await check(project, 'definition', async () => {
        const document = await documentWith(root, project, `item = Item.objects.first()\nitem.${own}`);
        const result = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
          'vscode.executeDefinitionProvider', document.uri, inside(document, own));
        const locations = result?.map(item => 'targetUri' in item ? item.targetUri.fsPath : item.uri.fsPath) ?? [];
        assert(locations.some(file => path.resolve(file) === path.join(root, project, 'inventory/models.py')), JSON.stringify(locations));
        assert(!locations.some(file => file.includes(path.sep + (project === 'one' ? 'two' : 'one') + path.sep)), JSON.stringify(locations));
        return locations;
      });
      await check(project, 'signature', async () => {
        const document = await documentWith(root, project, `Item.objects.create(${own}=`);
        const result = await vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', document.uri,
          document.positionAt(document.getText().lastIndexOf('=') + 1));
        const text = result?.signatures.map(item => item.label).join('\n') ?? '';
        assert(text.includes(own), text);
        assert(!text.includes(other), text);
        return text;
      });
      await check(project, 'inlay', async () => {
        const document = await documentWith(root, project, `Item.objects.filter(${own}__gte=1)`);
        const hints = await until(() => vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider',
          document.uri, new vscode.Range(0, 0, document.lineCount, 0)), result => Boolean(result?.length), 'Lookup inlay hint');
        const text = hints!.map(hint => typeof hint.label === 'string' ? hint.label : hint.label.map(part => part.value).join(''));
        assert(text.some(label => label.includes('int')), JSON.stringify(text));
        return text;
      });
      await check(project, 'diagnostics', async () => {
        const document = await documentWith(root, project, `Item.objects.filter(${other}=1)`);
        await document.save();
        const diagnostics = await until(() => vscode.languages.getDiagnostics(document.uri)
          .filter(item => item.source === 'Django ORM Intellisense'), values => values.some(item => item.message.includes(other)), 'Project-specific invalid lookup diagnostic');
        return diagnostics.map(item => item.message);
      });
      await check(project, 'save-reindex', async () => {
        const uri = vscode.Uri.file(path.join(root, project, 'inventory/models.py'));
        const model = await vscode.workspace.openTextDocument(uri);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, model.positionAt(model.getText().length), `\n    saved_${project} = models.IntegerField(default=0)\n`);
        assert(await vscode.workspace.applyEdit(edit));
        await model.save();
        const document = await documentWith(root, project, 'Item.objects.filter(saved_');
        const result = await until(() => vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider',
          document.uri, inside(document, 'saved_').translate(0, 1)), result => labels(result).includes('saved_' + project), 'Saved field completion');
        assert(!labels(result).includes('saved_' + (project === 'one' ? 'two' : 'one')));
        return labels(result).filter(name => name.startsWith('saved_'));
      });
      persist('running', {djangoVersion: daemon.getState().runtime?.djangoVersion});
    }
    const failures = observations.filter(row => !row.passed);
    persist(failures.length ? 'failed' : 'passed', {djangoVersion: daemon.getState().runtime?.djangoVersion,
      readyProjects: daemon.projectContexts.length, failures: failures.length,
      pythonExtension: python.packageJSON.version, pylanceExtension: pylance.packageJSON.version,
      pylanceActive: pylance.isActive});
    if (process.env.DJLS_MULTI_VISUAL_GATE) {
      const document = await documentWith(root, 'two', 'Item.objects.filter(only_two__gte=1)');
      const editor = await vscode.window.showTextDocument(document);
      const position = inside(document, 'only_two');
      editor.selection = new vscode.Selection(position, position);
      await vscode.commands.executeCommand('editor.action.showHover');
      fs.writeFileSync(process.env.DJLS_MULTI_VISUAL_GATE + '.ready', 'ready');
      const deadline = Date.now() + 60_000;
      while (!fs.existsSync(process.env.DJLS_MULTI_VISUAL_GATE) && Date.now() < deadline) await delay(200);
    }
    await daemon.stop();
    const client = getLanguageClientForTesting();
    if (client?.isRunning()) await client.stop();
    assert.equal(failures.length, 0, JSON.stringify(failures));
  } catch (error) {
    persist('failed', {error: String(error)});
    throw error;
  }
}
