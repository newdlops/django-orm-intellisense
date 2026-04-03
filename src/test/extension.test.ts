import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolvePythonInterpreter } from '../client/python/interpreter';

const EXTENSION_ID = 'newdlops.django-orm-intellisense';

suite('Django ORM Intellisense UI', () => {
  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension ${EXTENSION_ID} is not available.`);
    await extension.activate();
    await setPythonInterpreter(
      process.platform === 'win32' ? 'python' : 'python3'
    );
  });

  test('completes and resolves ORM lookup paths in fixture project', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const completionPosition = positionAfterText(document, 'author__pro');
    const completionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        completionPosition
      );

    assert.ok(completionList, 'Expected completion items for lookup path.');
    assert.ok(
      completionList.items.some((item) => item.label === 'profile'),
      'Expected lookup path completion to include `profile`.'
    );

    const hoverPosition = positionInsideText(document, 'author__profile__timezone', 'timezone');
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      hoverPosition
    );
    const hoverText = stringifyHovers(hovers);

    assert.ok(
      hoverText.includes('Owner model: `blog.Profile`'),
      `Expected lookup hover to mention the resolved owner model. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('Field kind: `CharField`'),
      `Expected lookup hover to mention the field kind. Received: ${hoverText}`
    );

    const definitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, hoverPosition);
    const definitionTarget = firstDefinition(definitions);

    assert.ok(definitionTarget, 'Expected a definition target for the lookup path.');
    const lookupDefinition = definitionTarget!;
    assert.ok(
      lookupDefinition.uri.fsPath.endsWith(
        path.join('fixtures', 'minimal_project', 'blog', 'models.py')
      ),
      `Expected lookup definition to target blog/models.py. Received: ${lookupDefinition.uri.fsPath}`
    );
    assert.strictEqual(lookupDefinition.range.start.line + 1, 28);
  });

  test('completes and resolves ORM keyword lookup paths in fixture project', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const fieldCompletionPosition = positionAfterTextInContainer(
      document,
      "filter(author__pro='mentor')",
      'author__pro'
    );
    const fieldCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        fieldCompletionPosition
      );

    assert.ok(
      fieldCompletionList?.items.some((item) => item.label === 'profile'),
      'Expected keyword lookup completion to include `profile`.'
    );
    const fieldCompletionItem = fieldCompletionList?.items.find(
      (item) => item.label === 'profile'
    );
    assert.strictEqual(
      fieldCompletionItem?.filterText,
      'author__profile',
      'Expected keyword lookup field completion to use the full lookup path as filterText.'
    );

    const inheritedBaseCompletionPosition = positionAfterTextInContainer(
      document,
      "AuditLog.objects.filter(na='entry')",
      'na'
    );
    const inheritedBaseCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        inheritedBaseCompletionPosition
      );

    assert.ok(
      inheritedBaseCompletionList?.items.some((item) => item.label === 'name'),
      'Expected abstract-base model keyword lookup completion to include `name`.'
    );

    const multilineCompletionPosition = positionAfterTextInContainer(
      document,
      "filter(\n        author__profile__time='Asia/Seoul',\n    )",
      'author__profile__time'
    );
    const multilineCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        multilineCompletionPosition
      );

    assert.ok(
      multilineCompletionList?.items.some((item) => item.label === 'timezone'),
      'Expected multiline keyword lookup completion to include `timezone`.'
    );

    const operatorCompletionPosition = positionAfterTextInContainer(
      document,
      "filter(author__profile__timezone__i='Asia/Seoul')",
      'author__profile__timezone__i'
    );
    const operatorCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        operatorCompletionPosition
      );

    assert.ok(
      operatorCompletionList?.items.some((item) => item.label === 'icontains'),
      'Expected keyword lookup operator completion to include `icontains`.'
    );
    const operatorCompletionItem = operatorCompletionList?.items.find(
      (item) => item.label === 'icontains'
    );
    assert.strictEqual(
      operatorCompletionItem?.filterText,
      'author__profile__timezone__icontains',
      'Expected keyword lookup operator completion to use the full lookup path as filterText.'
    );

    const hoverPosition = positionInsideText(
      document,
      "filter(author__profile__timezone='Asia/Seoul')",
      'timezone'
    );
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      hoverPosition
    );
    const hoverText = stringifyHovers(hovers);

    assert.ok(
      hoverText.includes('Owner model: `blog.Profile`'),
      `Expected keyword lookup hover to mention the resolved owner model. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('Field kind: `CharField`'),
      `Expected keyword lookup hover to mention the field kind. Received: ${hoverText}`
    );

    const definitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, hoverPosition);
    const definitionTarget = firstDefinition(definitions);

    assert.ok(
      definitionTarget,
      'Expected a definition target for the keyword lookup path.'
    );
    assert.strictEqual(
      definitionTarget!.range.start.line + 1,
      28,
      'Expected keyword lookup definition to target the Profile.timezone field.'
    );
  });

  test('infers queryset variable receivers in advanced fixture project', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(
      __dirname,
      '../../fixtures/advanced_queries_project'
    );
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'sales/query_examples.py'
    );

    const stringCompletionPosition = positionAfterTextInContainer(
      document,
      'active_products.values("category__ti")',
      'category__ti'
    );
    const stringCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        stringCompletionPosition
      );

    assert.ok(
      stringCompletionList?.items.some((item) => item.label === 'title'),
      'Expected queryset variable string lookup completion to include `title`.'
    );

    const keywordCompletionPosition = positionAfterTextInContainer(
      document,
      "active_products.filter(category__sl='chairs')",
      'category__sl'
    );
    const keywordCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        keywordCompletionPosition
      );

    assert.ok(
      keywordCompletionList?.items.some((item) => item.label === 'slug'),
      'Expected queryset variable keyword lookup completion to include `slug`.'
    );
    const keywordCompletionItem = keywordCompletionList?.items.find(
      (item) => item.label === 'slug'
    );
    assert.strictEqual(
      keywordCompletionItem?.filterText,
      'category__slug',
      'Expected queryset variable field completion to use the full lookup path as filterText.'
    );

    const multilineKeywordPosition = positionAfterTextInContainer(
      document,
      "filter(\n        category__ti='chairs',\n    )",
      'category__ti'
    );
    const multilineKeywordList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        multilineKeywordPosition
      );

    assert.ok(
      multilineKeywordList?.items.some((item) => item.label === 'title'),
      'Expected multiline queryset variable keyword lookup completion to include `title`.'
    );

    const chainedKeywordPosition = positionAfterTextInContainer(
      document,
      "Product.objects.active()\n        .filter(category__sl='chairs')",
      'category__sl'
    );
    const chainedKeywordList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        chainedKeywordPosition
      );

    assert.ok(
      chainedKeywordList?.items.some((item) => item.label === 'slug'),
      'Expected dot-chained keyword lookup completion to include `slug`.'
    );

    const chainedStringPosition = positionAfterTextInContainer(
      document,
      '.select_related("category")\n        .values("category__ti")',
      'category__ti'
    );
    const chainedStringList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        chainedStringPosition
      );

    assert.ok(
      chainedStringList?.items.some((item) => item.label === 'title'),
      'Expected dot-chained string lookup completion to include `title`.'
    );

    const hoverPosition = positionInsideText(
      document,
      'active_products.values("category__title")',
      'title'
    );
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      hoverPosition
    );
    const hoverText = stringifyHovers(hovers);

    assert.ok(
      hoverText.includes('Owner model: `catalog.Category`'),
      `Expected queryset variable hover to mention catalog.Category. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('Field kind: `CharField`'),
      `Expected queryset variable hover to mention CharField. Received: ${hoverText}`
    );

    const definitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, hoverPosition);
    const definitionTarget = firstDefinition(definitions);

    assert.ok(
      definitionTarget,
      'Expected a definition target for the queryset variable lookup path.'
    );
    assert.ok(
      definitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'advanced_queries_project', 'catalog', 'models.py')
      ),
      `Expected queryset variable definition to target catalog/models.py. Received: ${definitionTarget!.uri.fsPath}`
    );
    assert.strictEqual(definitionTarget!.range.start.line + 1, 6);
  });

  test('reports diagnostics for invalid ORM lookup paths', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) => item.message.includes('author__unknown')) &&
        items.some((item) => item.message.includes('timezone__bogus')) &&
        items.some((item) => item.message.includes('title__name')) &&
        items.some((item) => item.message.includes('select_related'))
    );

    assert.ok(
      diagnostics.some((item) =>
        item.message.includes('Unknown ORM lookup segment `unknown`')
      ),
      `Expected diagnostics to flag an unknown string lookup segment. Received: ${stringifyDiagnostics(diagnostics)}`
    );
    assert.ok(
      diagnostics.some((item) =>
        item.message.includes('Unknown Django lookup operator `bogus`')
      ),
      `Expected diagnostics to flag an unknown lookup operator segment. Received: ${stringifyDiagnostics(diagnostics)}`
    );
    assert.ok(
      diagnostics.some((item) =>
        item.message.includes('Unknown Django lookup operator `name`')
      ),
      `Expected diagnostics to flag non-relation traversal. Received: ${stringifyDiagnostics(diagnostics)}`
    );
    assert.ok(
      diagnostics.some((item) =>
        item.message.includes('`select_related` only accepts relation paths')
      ),
      `Expected diagnostics to flag invalid relation-only lookup paths. Received: ${stringifyDiagnostics(diagnostics)}`
    );
  });

  test('shows hover and definition for package re-export imports', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/reexport_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'library/import_examples.py'
    );

    const hoverPosition = positionInsideText(document, 'Book, Shelf', 'Book');
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      hoverPosition
    );
    const hoverText = stringifyHovers(hovers);

    assert.ok(
      hoverText.includes('defined in `library.models`'),
      `Expected import hover to describe the origin module. Received: ${hoverText}`
    );

    const definitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, hoverPosition);
    const definitionTarget = firstDefinition(definitions);

    assert.ok(definitionTarget, 'Expected a definition target for the re-exported symbol.');
    const importDefinition = definitionTarget!;
    assert.ok(
      importDefinition.uri.fsPath.endsWith(
        path.join('fixtures', 'reexport_project', 'library', 'models.py')
      ),
      `Expected import definition to target library/models.py. Received: ${importDefinition.uri.fsPath}`
    );
    assert.strictEqual(importDefinition.range.start.line + 1, 4);
  });

  test('infers base models from package re-export imports', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/reexport_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'library/import_examples.py'
    );

    const completionPosition = positionAfterTextInContainer(
      document,
      "Book.objects.filter(ti='x')",
      'ti'
    );
    const completionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        completionPosition
      );

    assert.ok(
      completionList?.items.some((item) => item.label === 'title'),
      'Expected re-exported model keyword lookup completion to include `title`.'
    );
  });

  test('resolves interpreter directories to concrete executables', async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'django-orm-intellisense-interpreter-')
    );

    try {
      const executableRelativePath =
        process.platform === 'win32'
          ? path.join('venv', 'Scripts', 'python.exe')
          : path.join('venv', 'bin', 'python');
      const executablePath = path.join(tempRoot, executableRelativePath);
      fs.mkdirSync(path.dirname(executablePath), { recursive: true });
      fs.writeFileSync(executablePath, '#!/usr/bin/env python3\n');

      if (process.platform !== 'win32') {
        fs.chmodSync(executablePath, 0o755);
      }

      const interpreter = await resolvePythonInterpreter({
        pythonInterpreter: 'venv',
        workspaceRoot: tempRoot,
        settingsModule: undefined,
        logLevel: 'off',
        autoStart: false,
      });

      assert.strictEqual(interpreter.path, executablePath);
      assert.strictEqual(
        interpreter.source,
        'djangoOrmIntellisense.pythonInterpreter'
      );

      const bareInterpreter = await resolvePythonInterpreter({
        pythonInterpreter: 'venv',
        workspaceRoot: tempRoot,
        settingsModule: undefined,
        logLevel: 'off',
        autoStart: false,
      });

      assert.strictEqual(bareInterpreter.path, executablePath);
      assert.strictEqual(
        bareInterpreter.source,
        'djangoOrmIntellisense.pythonInterpreter'
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

async function setWorkspaceRoot(rootPath: string): Promise<void> {
  await vscode.workspace
    .getConfiguration('djangoOrmIntellisense')
    .update(
      'workspaceRoot',
      rootPath,
      vscode.ConfigurationTarget.Workspace
    );
  await delay(1200);
}

async function setPythonInterpreter(interpreter: string): Promise<void> {
  await vscode.workspace
    .getConfiguration('djangoOrmIntellisense')
    .update(
      'pythonInterpreter',
      interpreter,
      vscode.ConfigurationTarget.Workspace
    );
  await delay(1200);
}

async function openFixtureDocument(
  fixtureRoot: string,
  relativePath: string
): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(
    path.join(fixtureRoot, relativePath)
  );
  await vscode.window.showTextDocument(document);
  await delay(300);
  return document;
}

function positionAfterText(
  document: vscode.TextDocument,
  searchText: string
): vscode.Position {
  const offset = document.getText().indexOf(searchText);
  assert.ok(offset >= 0, `Could not find text: ${searchText}`);
  return document.positionAt(offset + searchText.length);
}

function positionAfterTextInContainer(
  document: vscode.TextDocument,
  container: string,
  target: string
): vscode.Position {
  const containerOffset = document.getText().indexOf(container);
  assert.ok(containerOffset >= 0, `Could not find container text: ${container}`);
  const targetOffset = document.getText().indexOf(target, containerOffset);
  assert.ok(targetOffset >= 0, `Could not find target text: ${target}`);
  return document.positionAt(targetOffset + target.length);
}

function positionInsideText(
  document: vscode.TextDocument,
  container: string,
  target: string
): vscode.Position {
  const containerOffset = document.getText().indexOf(container);
  assert.ok(containerOffset >= 0, `Could not find container text: ${container}`);
  const targetOffset = document.getText().indexOf(target, containerOffset);
  assert.ok(targetOffset >= 0, `Could not find target text: ${target}`);
  return document.positionAt(targetOffset + Math.floor(target.length / 2));
}

function stringifyHovers(hovers: vscode.Hover[] | undefined): string {
  return (hovers ?? [])
    .flatMap((hover) =>
      hover.contents.map((content) => {
        if (content instanceof vscode.MarkdownString) {
          return content.value;
        }

        if (typeof content === 'string') {
          return content;
        }

        return content.value;
      })
    )
    .join('\n');
}

function firstDefinition(
  definitions: Array<vscode.Location | vscode.LocationLink> | undefined
): vscode.Location | undefined {
  const first = definitions?.[0];
  if (!first) {
    return undefined;
  }

  if ('targetUri' in first) {
    return new vscode.Location(
      first.targetUri,
      first.targetSelectionRange ?? first.targetRange
    );
  }

  return first;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDiagnostics(
  uri: vscode.Uri,
  predicate: (items: readonly vscode.Diagnostic[]) => boolean,
  timeoutMs = 10_000
): Promise<readonly vscode.Diagnostic[]> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    if (predicate(diagnostics)) {
      return diagnostics;
    }
    await delay(200);
  }

  return vscode.languages.getDiagnostics(uri);
}

function stringifyDiagnostics(items: readonly vscode.Diagnostic[]): string {
  return items.map((item) => item.message).join(' | ');
}
