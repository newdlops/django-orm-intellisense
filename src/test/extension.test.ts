import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getActiveDaemonForTesting } from '../client/extension';
import type { HealthSnapshot } from '../client/protocol';
import {
  resolvePythonInterpreter,
  savePythonInterpreterSetting,
  validatePythonInterpreterPath,
} from '../client/python/interpreter';

const EXTENSION_ID = 'newdlops.django-orm-intellisense';
const FIXTURES_ROOT = path.resolve(__dirname, '../../fixtures');
const DJANGO_E2E_MAJOR_VERSION = 5;

interface FixtureE2EProjectConfig {
  settingsModule: string;
}

interface FixtureE2EEnvironment extends FixtureE2EProjectConfig {
  interpreterPath: string;
  djangoVersion: string;
}

const FIXTURE_E2E_PROJECTS: Record<string, FixtureE2EProjectConfig> = {
  minimal_project: {
    settingsModule: 'project.settings',
  },
  advanced_queries_project: {
    settingsModule: 'core.settings',
  },
  reexport_project: {
    settingsModule: 'config.settings',
  },
};

const fixtureE2EEnvironmentCache = new Map<string, FixtureE2EEnvironment>();
let django5BaseInterpreterCache: string | undefined;
let testCacheRoot: string | undefined;
let fixtureHarnessWorkspacePath: string | undefined;
const E2E_PROCESS_TAG = `${process.pid}`;

suite('Django ORM Intellisense UI', () => {
  suiteSetup(async () => {
    testCacheRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'django-orm-intellisense-test-cache-')
    );
    process.env.DJANGO_ORM_INTELLISENSE_CACHE_DIR = testCacheRoot;
    process.env.DJLS_DISABLE_AUTO_RESTARTS = '1';
    process.env.DJLS_DISABLE_PROVIDER_TIMEOUT = '1';
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension ${EXTENSION_ID} is not available.`);
    await extension.activate();
  });

  suiteTeardown(async () => {
    await removeWorkspaceFoldersFrom(0);
    await clearExtensionSetting('workspaceRoot');
    await clearExtensionSetting('pythonInterpreter');
    await clearExtensionSetting('settingsModule');
    if (fixtureHarnessWorkspacePath) {
      fs.rmSync(fixtureHarnessWorkspacePath, { recursive: true, force: true });
      fixtureHarnessWorkspacePath = undefined;
    }
    delete process.env.DJANGO_ORM_INTELLISENSE_CACHE_DIR;
    delete process.env.DJLS_DISABLE_AUTO_RESTARTS;
    delete process.env.DJLS_DISABLE_PROVIDER_TIMEOUT;
    if (testCacheRoot) {
      fs.rmSync(testCacheRoot, { recursive: true, force: true });
      testCacheRoot = undefined;
    }
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
      hasCompletionItemLabel(completionList.items, 'profile'),
      'Expected lookup path completion to include `profile`.'
    );
    const relationCompletionItem = findCompletionItemByLabel(
      completionList.items,
      'profile'
    );
    assert.strictEqual(
      relationCompletionItem?.insertText,
      'profile__',
      'Expected string lookup relation completion to continue the `__` chain.'
    );
    assert.strictEqual(
      relationCompletionItem?.command?.command,
      'editor.action.triggerSuggest',
      'Expected string lookup relation completion to reopen suggestions.'
    );
    assert.strictEqual(
      relationCompletionItem?.detail,
      'OneToOneField · Author -> Profile',
      'Expected relation lookup completion detail to stay compact while showing the related model.'
    );
    assert.strictEqual(
      completionItemLabelDetail(relationCompletionItem!),
      ' (OneToOneField)',
      'Expected relation lookup completion to show the field kind inline in the suggestion list.'
    );
    assert.strictEqual(
      completionItemDescription(relationCompletionItem!),
      'Author -> Profile',
      'Expected relation lookup completion to show the owner and related model inline in the suggestion list.'
    );

    const nestedCompletionPosition = positionAfterTextInContainer(
      document,
      'Post.objects.values("author__profile__timezone")',
      'author__profile__tim'
    );
    const nestedCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        nestedCompletionPosition
      );
    const nestedCompletionItem = findCompletionItemByLabel(
      nestedCompletionList?.items,
      'timezone'
    );

    assert.ok(
      nestedCompletionItem,
      'Expected nested lookup completion to include `timezone` after typing `author__profile__`.'
    );
    assert.strictEqual(
      nestedCompletionItem?.insertText,
      'timezone',
      'Expected nested string lookup completion to insert the visible field segment.'
    );
    assert.strictEqual(
      completionItemFilterValue(nestedCompletionItem!),
      'author__profile__timezone',
      'Expected nested string lookup completion to preserve the full lookup prefix for editor filtering.'
    );

    const operatorCompletionPosition = positionAfterTextInContainer(
      document,
      "filter(author__profile__timezone__='Asia/Seoul')",
      'author__profile__timezone__'
    );
    const operatorCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        operatorCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(operatorCompletionList?.items, 'contains'),
      'Expected lookup operator completion to include `contains` after a completed field path.'
    );
    assert.ok(
      hasCompletionItemLabel(operatorCompletionList?.items, 'gte'),
      'Expected lookup operator completion to include `gte` after a completed field path.'
    );
    assert.ok(
      hasCompletionItemLabel(operatorCompletionList?.items, 'in'),
      'Expected lookup operator completion to include `in` after a completed field path.'
    );
    const containsOperatorItem = findCompletionItemByLabel(
      operatorCompletionList?.items,
      'contains'
    );
    assert.strictEqual(
      completionItemDescription(containsOperatorItem!),
      'lookup · Profile.timezone',
      'Expected lookup operator completion to expose the owning Django field inline in the suggestion list.'
    );

    const directPkCompletionPosition = positionAfterTextInContainer(
      document,
      'Post.objects.filter(p=1)',
      'p'
    );
    const directPkCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        directPkCompletionPosition
      );
    const directPkCompletionItem = (directPkCompletionList?.items ?? []).find(
      (item) =>
        completionItemLabel(item) === 'pk' &&
        item.detail === 'BigAutoField · Post'
    );

    assert.ok(
      directPkCompletionItem,
      `Expected filter() completion to include the pk alias. Received: ${(directPkCompletionList?.items ?? [])
        .slice(0, 20)
        .map((item) => `${completionItemDisplayLabel(item)} | ${item.detail ?? '<no detail>'}`)
        .join(', ')}`
    );
    assert.strictEqual(
      directPkCompletionItem!.insertText,
      'pk__',
      'Expected pk lookup completion to continue the operator chain.'
    );

    const relatedPkCompletionPosition = positionAfterTextInContainer(
      document,
      'Post.objects.filter(author__p=1)',
      'author__p'
    );
    const relatedPkCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        relatedPkCompletionPosition
      );
    const relatedPkCompletionItem = (relatedPkCompletionList?.items ?? []).find(
      (item) =>
        completionItemLabel(item) === 'pk' &&
        item.detail === 'BigAutoField · Author'
    );

    assert.ok(
      relatedPkCompletionItem,
      `Expected related lookup completion to include the related model pk alias. Received: ${(relatedPkCompletionList?.items ?? [])
        .slice(0, 20)
        .map((item) => `${completionItemDisplayLabel(item)} | ${item.detail ?? '<no detail>'}`)
        .join(', ')}`
    );

    const pkOperatorCompletionPosition = positionAfterTextInContainer(
      document,
      'Post.objects.filter(pk__i=[1, 2])',
      'pk__i'
    );
    const pkOperatorCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        pkOperatorCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(pkOperatorCompletionList?.items, 'in'),
      'Expected pk lookup operator completion to include `in`.'
    );

    const hiddenReverseCompletionPosition = positionAfterTextInContainer(
      document,
      "HiddenReverseTag.objects.filter(_b='hidden')",
      '_b'
    );
    const hiddenReverseCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        hiddenReverseCompletionPosition
      );

    // The `_b` prefix doesn't match any visible field on HiddenReverseTag, so
    // the completion list may be empty.  An empty list trivially satisfies the
    // constraint that the hidden accessor is absent.
    assert.ok(
      !hasCompletionItemLabel(
        hiddenReverseCompletionList?.items ?? [],
        '_blog_hiddenreversepost_tags_+'
      ),
      'Expected hidden reverse ManyToMany accessors to stay out of lookup completion.'
    );

    const hiddenReverseOperatorCompletionPosition = positionAfterTextInContainer(
      document,
      "HiddenReverseTag.objects.filter(_blog_hiddenreversepost_tags_+__i=['hidden'])",
      '_blog_hiddenreversepost_tags_+__i'
    );
    const hiddenReverseOperatorCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        hiddenReverseOperatorCompletionPosition
      );

    // The `+` in the accessor name is not valid Python, so the provider may
    // return no items.  An empty list trivially means `in` is absent.
    assert.ok(
      !hasCompletionItemLabel(hiddenReverseOperatorCompletionList?.items ?? [], 'in'),
      'Expected hidden reverse ManyToMany accessors to avoid lookup-operator completion.'
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

    const directPkHoverPosition = positionInsideText(
      document,
      'Post.objects.filter(pk=1)',
      'pk'
    );
    const directPkHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      directPkHoverPosition
    );
    const directPkHoverText = stringifyHovers(directPkHovers);

    assert.ok(
      directPkHoverText.includes('Owner model: `blog.Post`'),
      `Expected pk hover to mention blog.Post. Received: ${directPkHoverText}`
    );
    assert.ok(
      directPkHoverText.includes('Field kind: `BigAutoField`'),
      `Expected pk hover to mention the primary-key field kind. Received: ${directPkHoverText}`
    );

    const relatedPkHoverPosition = positionInsideText(
      document,
      'Post.objects.filter(author__pk=1)',
      'pk'
    );
    const relatedPkHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      relatedPkHoverPosition
    );
    const relatedPkHoverText = stringifyHovers(relatedPkHovers);

    assert.ok(
      relatedPkHoverText.includes('Owner model: `blog.Author`'),
      `Expected related pk hover to mention blog.Author. Received: ${relatedPkHoverText}`
    );
    assert.ok(
      relatedPkHoverText.includes('Field kind: `BigAutoField`'),
      `Expected related pk hover to mention the primary-key field kind. Received: ${relatedPkHoverText}`
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
    assert.strictEqual(lookupDefinition.range.start.line + 1, 40);

    const directPkDefinitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, directPkHoverPosition);
    const directPkDefinitionTarget = firstDefinition(directPkDefinitions);

    assert.ok(
      directPkDefinitionTarget,
      'Expected pk lookup to resolve to a definition target.'
    );
    assert.ok(
      directPkDefinitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'minimal_project', 'blog', 'models.py')
      ),
      `Expected pk definition to target blog/models.py. Received: ${directPkDefinitionTarget!.uri.fsPath}`
    );
  });

  test('preserves chained lookup completions when the local fast path is enabled', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    await withProcessEnv('DJLS_ENABLE_LOCAL_LOOKUP_FAST_PATH', '1', async () => {
      const document = await openFixtureDocument(
        fixtureRoot,
        'blog/query_examples.py'
      );

      const blankCompletionPosition = positionAfterTextInContainer(
        document,
        'Post.objects.filter()',
        'filter('
      );
      const blankCompletionList =
        await vscode.commands.executeCommand<vscode.CompletionList>(
          'vscode.executeCompletionItemProvider',
          document.uri,
          blankCompletionPosition
        );

      assert.ok(
        hasCompletionItemLabel(blankCompletionList?.items, 'author__profile'),
        `Expected local fast path completion to include eager chained lookups. Received: ${(blankCompletionList?.items ?? [])
          .slice(0, 20)
          .map((item) => `${completionItemDisplayLabel(item)} | ${item.detail ?? '<no detail>'}`)
          .join(', ')}`
      );
      assert.ok(
        hasCompletionItemLabel(blankCompletionList?.items, 'author__in'),
        'Expected local fast path completion to include prefixed lookup operators.'
      );

      const nestedCompletionPosition = positionAfterTextInContainer(
        document,
        'Post.objects.values("author__profile__timezone")',
        'author__profile__tim'
      );
      const nestedCompletionList =
        await vscode.commands.executeCommand<vscode.CompletionList>(
          'vscode.executeCompletionItemProvider',
          document.uri,
          nestedCompletionPosition
        );

      assert.ok(
        hasCompletionItemLabel(nestedCompletionList?.items, 'timezone'),
        `Expected local fast path completion to preserve nested segment suggestions. Received: ${(nestedCompletionList?.items ?? [])
          .slice(0, 20)
          .map((item) => `${completionItemDisplayLabel(item)} | ${item.detail ?? '<no detail>'}`)
          .join(', ')}`
      );
    });
  });

  test('reindexes configured workspaceRoot files through the file watcher', async function () {
    this.timeout(30_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    const environment = await ensureFixtureE2EEnvironment(fixtureRoot);
    assert.ok(environment, 'Expected a reusable E2E environment for the fixture project.');

    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'django-orm-intellisense-watcher-root-')
    );
    copyDirectory(fixtureRoot, tempRoot);

    const queryExamplesPath = path.join(tempRoot, 'blog', 'query_examples.py');
    fs.appendFileSync(queryExamplesPath, "\nPost.objects.filter(sub='watcher')\n", 'utf8');

    await removeWorkspaceFoldersFrom(0);

    try {
      const daemon = getActiveDaemonForTesting();
      assert.ok(daemon, 'Expected the analysis daemon to be active after extension activation.');

      const fixtureWorkspace = ensureFixtureWorkspace(tempRoot, environment);
      await addWorkspaceFolder(fixtureWorkspace);
      await applyFixtureWorkspaceSettings(fixtureWorkspace, tempRoot, environment);

      const initialSnapshot = await daemon.restart(vscode.Uri.file(fixtureWorkspace));
      const snapshot =
        initialSnapshot.phase === 'ready' &&
        initialSnapshot.runtime?.bootstrapStatus === 'ready'
          ? initialSnapshot
          : await waitForHealthSnapshot(
              daemon,
              (candidate) =>
                candidate.phase === 'ready' &&
                candidate.runtime?.bootstrapStatus === 'ready',
              30_000
            );
      assertFixtureE2EHealth(snapshot, tempRoot, environment);

      const modelsPath = path.join(tempRoot, 'blog', 'models.py');
      const originalModels = fs.readFileSync(modelsPath, 'utf8');
      const updatedModels = originalModels.replace(
        "    title = models.CharField(max_length=255)\n",
        "    title = models.CharField(max_length=255)\n    subtitle = models.CharField(max_length=255, blank=True)\n"
      );
      assert.notStrictEqual(
        updatedModels,
        originalModels,
        'Expected to inject a watcher test field into blog.Post.'
      );
      fs.writeFileSync(modelsPath, updatedModels, 'utf8');

      await waitForCondition(
        () =>
          Boolean(
            daemon.surfaceIndex['blog.Post']?.queryset?.subtitle ??
            daemon.surfaceIndex['blog.Post']?.manager?.subtitle ??
            daemon.surfaceIndex['blog.Post']?.instance?.subtitle
          ),
        15_000
      );

      const document = await openFixtureDocument(
        tempRoot,
        'blog/query_examples.py'
      );
      const completionPosition = positionAfterText(document, 'Post.objects.filter(sub');
      const completionList =
        await vscode.commands.executeCommand<vscode.CompletionList>(
          'vscode.executeCompletionItemProvider',
          document.uri,
          completionPosition
        );

      assert.ok(
        hasCompletionItemLabel(completionList?.items ?? [], 'subtitle'),
        `Expected file-watcher reindex to surface the new field. Received: ${(completionList?.items ?? [])
          .slice(0, 20)
          .map((item) => `${completionItemDisplayLabel(item)} | ${item.detail ?? '<no detail>'}`)
          .join(', ')}`
      );
    } finally {
      await removeWorkspaceFoldersFrom(0);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('resolves runtime-backed reverse lookup paths with non-literal related_name', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const completionPosition = positionAfterTextInContainer(
      document,
      'Company.objects.values("corporate_registration__registration_code")',
      'corporate_registration__reg'
    );
    const completionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        completionPosition
      );

    assert.ok(
      hasCompletionItemLabel(completionList?.items, 'registration_code'),
      'Expected reverse lookup completion to include `registration_code`.'
    );

    const hoverPosition = positionInsideText(
      document,
      'Company.objects.values("corporate_registration__registration_code")',
      'registration_code'
    );
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      hoverPosition
    );
    const hoverText = stringifyHovers(hovers);

    assert.ok(
      hoverText.includes('Owner model: `blog.CorporateRegistration`'),
      `Expected reverse lookup hover to mention the resolved owner model. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('Field kind: `CharField`'),
      `Expected reverse lookup hover to mention the field kind. Received: ${hoverText}`
    );

    const definitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, hoverPosition);
    const definitionTarget = firstDefinition(definitions);

    assert.ok(
      definitionTarget,
      'Expected a definition target for the runtime-backed reverse lookup path.'
    );
    assert.strictEqual(
      definitionTarget!.range.start.line + 1,
      127,
      'Expected reverse lookup definition to target the CorporateRegistration.registration_code field.'
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) => item.message.includes('author__unknown'))
    );
    assert.ok(diagnostics.length > 0, 'Expected diagnostics to be non-empty before checking absence of valid paths');
    assert.ok(
      diagnostics.every(
        (item) => !item.message.includes('corporate_registration__registration_code')
      ),
      `Expected runtime-backed reverse lookup path to avoid diagnostics. Received: ${stringifyDiagnostics(diagnostics)}`
    );
  });

  test('resolves reverse lookup paths when Meta.app_label overrides the module root', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const completionPosition = positionAfterTextInContainer(
      document,
      'AppLabelCompany.objects.values("corporate_registration__registration_code")',
      'corporate_registration__reg'
    );
    const completionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        completionPosition
      );

    assert.ok(
      hasCompletionItemLabel(completionList?.items, 'registration_code'),
      'Expected app-label-overridden reverse lookup completion to include `registration_code`.'
    );

    const hoverPosition = positionInsideText(
      document,
      'AppLabelCompany.objects.values("corporate_registration__registration_code")',
      'registration_code'
    );
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      hoverPosition
    );
    const hoverText = stringifyHovers(hovers);

    assert.ok(
      hoverText.includes('Owner model: `db.AppLabelCorporateRegistration`'),
      `Expected app-label-overridden reverse lookup hover to mention db.AppLabelCorporateRegistration. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('Field kind: `CharField`'),
      `Expected app-label-overridden reverse lookup hover to mention the field kind. Received: ${hoverText}`
    );

    const definitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, hoverPosition);
    const definitionTarget = firstDefinition(definitions);

    assert.ok(
      definitionTarget,
      'Expected a definition target for the app-label-overridden reverse lookup path.'
    );
    assert.strictEqual(
      definitionTarget!.range.start.line + 1,
      186,
      'Expected app-label-overridden reverse lookup definition to target AppLabelCorporateRegistration.registration_code.'
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) => item.message.includes('author__unknown'))
    );
    assert.ok(diagnostics.length > 0, 'Expected diagnostics to be non-empty before checking absence of valid paths');
    assert.ok(
      diagnostics.every(
        (item) => !item.message.includes('corporate_registration__registration_code')
      ),
      `Expected app-label-overridden reverse lookup path to avoid diagnostics. Received: ${stringifyDiagnostics(diagnostics)}`
    );
  });

  test('supports values_list, prefetch_related, only, and defer string paths', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const valuesListCompletionPosition = positionAfterTextInContainer(
      document,
      'Post.objects.values_list("author__pro")',
      'author__pro'
    );
    const valuesListCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        valuesListCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(valuesListCompletionList?.items, 'profile'),
      'Expected values_list() completion to include `profile`.'
    );

    const prefetchCompletionPosition = positionAfterTextInContainer(
      document,
      'Post.objects.prefetch_related("author__pro")',
      'author__pro'
    );
    const prefetchCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        prefetchCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(prefetchCompletionList?.items, 'profile'),
      'Expected prefetch_related() completion to include `profile`.'
    );

    const prefetchWrapperCompletionPosition = positionAfterTextInContainer(
      document,
      'Post.objects.prefetch_related(Prefetch("author__pro"))',
      'author__pro'
    );
    const prefetchWrapperCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        prefetchWrapperCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(prefetchWrapperCompletionList?.items, 'profile'),
      'Expected Prefetch() completion to include `profile`.'
    );

    const onlyCompletionPosition = positionAfterTextInContainer(
      document,
      'Post.objects.only("author__na")',
      'author__na'
    );
    const onlyCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        onlyCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(onlyCompletionList?.items, 'name'),
      'Expected only() completion to include `name`.'
    );

    const deferCompletionPosition = positionAfterTextInContainer(
      document,
      'Post.objects.defer("author__na")',
      'author__na'
    );
    const deferCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        deferCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(deferCompletionList?.items, 'name'),
      'Expected defer() completion to include `name`.'
    );

    const hoverPosition = positionInsideText(
      document,
      'Post.objects.values_list("author__profile__timezone")',
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
      `Expected values_list() hover to mention blog.Profile. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('Field kind: `CharField`'),
      `Expected values_list() hover to mention CharField. Received: ${hoverText}`
    );

    const definitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, hoverPosition);
    const definitionTarget = firstDefinition(definitions);

    assert.ok(
      definitionTarget,
      'Expected values_list() string path definition to resolve to the model field.'
    );
    assert.ok(
      definitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'minimal_project', 'blog', 'models.py')
      ),
      `Expected values_list() definition to target blog/models.py. Received: ${definitionTarget!.uri.fsPath}`
    );
    assert.strictEqual(
      definitionTarget!.range.start.line + 1,
      40,
      'Expected values_list() definition to target the Profile.timezone field.'
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) =>
          item.message.includes('`prefetch_related` only accepts relation paths')
        )
    );
    assert.ok(
      diagnostics.some((item) =>
        item.message.includes('`prefetch_related` only accepts relation paths')
      ),
      `Expected prefetch_related() diagnostics to flag non-relation paths. Received: ${stringifyDiagnostics(diagnostics)}`
    );

    const prefetchWrapperHoverPosition = positionInsideText(
      document,
      'Post.objects.prefetch_related(Prefetch("author__profile"))',
      'profile'
    );
    const prefetchWrapperHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      prefetchWrapperHoverPosition
    );
    const prefetchWrapperHoverText = stringifyHovers(prefetchWrapperHovers);

    assert.ok(
      prefetchWrapperHoverText.includes('Owner model: `blog.Author`'),
      `Expected Prefetch() hover to mention blog.Author. Received: ${prefetchWrapperHoverText}`
    );
  });

  test('supports relation-string field declarations', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/relation_examples.py'
    );

    const foreignKeyCompletionPosition = positionAfterTextInContainer(
      document,
      'models.ForeignKey("blog.Aut", on_delete=models.CASCADE)',
      'blog.Aut'
    );
    const foreignKeyCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        foreignKeyCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(foreignKeyCompletionList?.items, 'blog.Author'),
      'Expected ForeignKey() relation completion to include `blog.Author`.'
    );

    const foreignKeyToCompletionPosition = positionAfterTextInContainer(
      document,
      'models.ForeignKey(to="blog.Aut", on_delete=models.CASCADE)',
      'blog.Aut'
    );
    const foreignKeyToCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        foreignKeyToCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(foreignKeyToCompletionList?.items, 'blog.Author'),
      'Expected ForeignKey(to=...) completion to include `blog.Author`.'
    );

    const manyToManyCompletionPosition = positionAfterTextInContainer(
      document,
      'models.ManyToManyField("blog.Ta")',
      'blog.Ta'
    );
    const manyToManyCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        manyToManyCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(manyToManyCompletionList?.items, 'blog.Tag'),
      'Expected ManyToManyField() relation completion to include `blog.Tag`.'
    );

    const parentalKeyCompletionPosition = positionAfterTextInContainer(
      document,
      'ParentalKey(to="blog.Fa", on_delete=models.CASCADE)',
      'blog.Fa'
    );
    const parentalKeyCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        parentalKeyCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(parentalKeyCompletionList?.items, 'blog.Faq'),
      'Expected ParentalKey(to=...) completion to include `blog.Faq`.'
    );

    const hoverPosition = positionInsideText(
      document,
      'models.OneToOneField("blog.Profile", on_delete=models.CASCADE)',
      'blog.Profile'
    );
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      hoverPosition
    );
    const hoverText = stringifyHovers(hovers);

    assert.ok(
      hoverText.includes('blog.Profile'),
      `Expected relation-string hover to mention blog.Profile. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('Module: `blog.models`'),
      `Expected relation-string hover to mention blog.models. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('Resolved symbol: `blog.models.Profile`'),
      `Expected relation-string hover to mention the resolved symbol. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('Import hint: `from blog.models import Profile`'),
      `Expected relation-string hover to include an import hint. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('File: `blog/models.py`'),
      `Expected relation-string hover to mention the resolved file. Received: ${hoverText}`
    );

    const foreignKeyTailHoverPosition = positionInsideText(
      document,
      'models.ForeignKey("blog.Profile", on_delete=models.CASCADE)',
      'Profile'
    );
    const foreignKeyTailHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        foreignKeyTailHoverPosition
      );
    const foreignKeyTailHoverText = stringifyHovers(foreignKeyTailHovers);

    assert.ok(
      foreignKeyTailHoverText.includes('Resolved symbol: `blog.models.Profile`'),
      `Expected dotted ForeignKey relation-string hover on the tail symbol to resolve as blog.models.Profile. Received: ${foreignKeyTailHoverText}`
    );
    assert.ok(
      foreignKeyTailHoverText.includes(
        'Resolved from string reference `blog.Profile`.'
      ),
      `Expected dotted ForeignKey relation-string hover on the tail symbol to preserve the original string reference. Received: ${foreignKeyTailHoverText}`
    );

    const bareHoverPosition = positionInsideText(
      document,
      'models.ForeignKey("Profile", on_delete=models.CASCADE)',
      'Profile'
    );
    const bareHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      bareHoverPosition
    );
    const bareHoverText = stringifyHovers(bareHovers);

    assert.ok(
      bareHoverText.includes('Import hint: `from blog.models import Profile`'),
      `Expected bare relation-string hover to include an import hint. Received: ${bareHoverText}`
    );
    assert.ok(
      bareHoverText.includes('Resolved from string reference `Profile`.'),
      `Expected bare relation-string hover to mention the original string reference. Received: ${bareHoverText}`
    );

    const parentalKeyHoverPosition = positionInsideText(
      document,
      'ParentalKey(to="blog.Faq", on_delete=models.CASCADE)',
      'blog.Faq'
    );
    const parentalKeyHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      parentalKeyHoverPosition
    );
    const parentalKeyHoverText = stringifyHovers(parentalKeyHovers);

    assert.ok(
      parentalKeyHoverText.includes('blog.Faq'),
      `Expected ParentalKey() hover to mention blog.Faq. Received: ${parentalKeyHoverText}`
    );

    const definitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, hoverPosition);
    const definitionTarget = firstDefinition(definitions);

    assert.ok(
      definitionTarget,
      'Expected relation-string definition to resolve to the target model.'
    );
    assert.ok(
      definitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'minimal_project', 'blog', 'models.py')
      ),
      `Expected relation-string definition to target blog/models.py. Received: ${definitionTarget!.uri.fsPath}`
    );
    assert.strictEqual(
      definitionTarget!.range.start.line + 1,
      34,
      'Expected relation-string definition to target the Profile model.'
    );

    const foreignKeyTailDefinitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >(
      'vscode.executeDefinitionProvider',
      document.uri,
      foreignKeyTailHoverPosition
    );
    const foreignKeyTailDefinitionTarget = firstDefinition(
      foreignKeyTailDefinitions
    );

    assert.ok(
      foreignKeyTailDefinitionTarget,
      'Expected dotted ForeignKey relation-string tail symbol to resolve to the target model.'
    );
    assert.ok(
      foreignKeyTailDefinitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'minimal_project', 'blog', 'models.py')
      ),
      `Expected dotted ForeignKey relation-string tail symbol definition to target blog/models.py. Received: ${foreignKeyTailDefinitionTarget!.uri.fsPath}`
    );
    assert.strictEqual(
      foreignKeyTailDefinitionTarget!.range.start.line + 1,
      34,
      'Expected dotted ForeignKey relation-string tail symbol definition to target the Profile model.'
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) =>
          item.message.includes('Unknown Django model reference `blog.UnknownModel`')
        )
    );
    assert.ok(
      diagnostics.some((item) =>
        item.message.includes('Unknown Django model reference `blog.UnknownModel`')
      ),
      `Expected relation-string diagnostics to flag unknown model references. Received: ${stringifyDiagnostics(diagnostics)}`
    );
  });

  test('supports custom base models and ParentalKey reverse relations', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const titleCompletionPosition = positionAfterTextInContainer(
      document,
      "Faq.objects.filter(ti='faq')",
      'ti'
    );
    const titleCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        titleCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(titleCompletionList?.items, 'title'),
      'Expected custom-base model completion to include `title`.'
    );

    const titleHoverPosition = positionInsideText(
      document,
      "Faq.objects.filter(title='faq')",
      'title'
    );
    const titleHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      titleHoverPosition
    );
    const titleHoverText = stringifyHovers(titleHovers);

    assert.ok(
      titleHoverText.includes('Owner model: `blog.Faq`'),
      `Expected custom-base field hover to mention blog.Faq. Received: ${titleHoverText}`
    );
    assert.ok(
      titleHoverText.includes('Field kind: `CharField`'),
      `Expected custom-base field hover to mention CharField. Received: ${titleHoverText}`
    );

    const titleDefinitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, titleHoverPosition);
    const titleDefinitionTarget = firstDefinition(titleDefinitions);

    assert.ok(
      titleDefinitionTarget,
      'Expected custom-base field definition to resolve to the model field.'
    );
    assert.ok(
      titleDefinitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'minimal_project', 'blog', 'models.py')
      ),
      `Expected custom-base field definition to target blog/models.py. Received: ${titleDefinitionTarget!.uri.fsPath}`
    );

    const reverseCompletionPosition = positionAfterTextInContainer(
      document,
      'Faq.objects.prefetch_related("li")',
      'li'
    );
    const reverseCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        reverseCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(reverseCompletionList?.items, 'link_set'),
      'Expected ParentalKey reverse relation completion to include `link_set`.'
    );
    assert.ok(
      !hasCompletionItemLabel(reverseCompletionList?.items, 'link'),
      'Expected prefetch_related() completion to keep `related_query_name` aliases out of relation-only paths.'
    );

    const reverseHoverPosition = positionInsideText(
      document,
      'Faq.objects.prefetch_related("link_set")',
      'link_set'
    );
    const reverseHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      reverseHoverPosition
    );
    const reverseHoverText = stringifyHovers(reverseHovers);

    assert.ok(
      reverseHoverText.includes('Owner model: `blog.Faq`'),
      `Expected ParentalKey reverse relation hover to mention blog.Faq. Received: ${reverseHoverText}`
    );
  });

  test('supports reverse related_query_name lookups without leaking into relation-only paths', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const queryNameCompletionPosition = positionAfterTextInContainer(
      document,
      "Faq.objects.filter(li='faq')",
      'li'
    );
    const queryNameCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        queryNameCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(queryNameCompletionList?.items, 'link'),
      'Expected reverse related_query_name completion to include `link`.'
    );

    const queryNameHoverPosition = positionInsideText(
      document,
      "Faq.objects.filter(link__label='faq')",
      'label'
    );
    const queryNameHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      queryNameHoverPosition
    );
    const queryNameHoverText = stringifyHovers(queryNameHovers);

    assert.ok(
      queryNameHoverText.includes('Owner model: `blog.FaqLink`'),
      `Expected reverse related_query_name hover to mention blog.FaqLink. Received: ${queryNameHoverText}`
    );
    assert.ok(
      queryNameHoverText.includes('Field kind: `CharField`'),
      `Expected reverse related_query_name hover to mention CharField. Received: ${queryNameHoverText}`
    );

    const queryNameDefinitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, queryNameHoverPosition);
    const queryNameDefinitionTarget = firstDefinition(queryNameDefinitions);

    assert.ok(
      queryNameDefinitionTarget,
      'Expected reverse related_query_name definition to resolve to the related model field.'
    );
    assert.ok(
      queryNameDefinitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'minimal_project', 'blog', 'models.py')
      ),
      `Expected reverse related_query_name definition to target blog/models.py. Received: ${queryNameDefinitionTarget!.uri.fsPath}`
    );
    assert.strictEqual(
      queryNameDefinitionTarget!.range.start.line + 1,
      160,
      'Expected reverse related_query_name definition to target FaqLink.label.'
    );

    const prefetchQueryNamePosition = positionInsideText(
      document,
      'Faq.objects.prefetch_related("link")',
      'link'
    );
    const prefetchQueryNameHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        prefetchQueryNamePosition
      );

    assert.strictEqual(
      stringifyHovers(prefetchQueryNameHovers),
      '',
      'Expected prefetch_related("link") to stay unresolved because relation-only paths should use accessors, not related_query_name.'
    );

    const prefetchQueryNameDefinitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >(
      'vscode.executeDefinitionProvider',
      document.uri,
      prefetchQueryNamePosition
    );

    assert.ok(
      !firstDefinition(prefetchQueryNameDefinitions),
      'Expected prefetch_related("link") to avoid resolving a definition target.'
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) => items.some((item) => item.message.includes('author__unknown'))
    );

    assert.ok(diagnostics.length > 0, 'Expected diagnostics to be non-empty before checking absence of valid paths');
    assert.ok(
      diagnostics.every((item) => !item.message.includes('link__label')),
      `Expected reverse related_query_name filter paths to avoid diagnostics. Received: ${stringifyDiagnostics(diagnostics)}`
    );
  });

  test('resolves runtime-backed custom fields in keyword lookups', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const completionPosition = positionAfterTextInContainer(
      document,
      "Company.objects.filter(st='READY')",
      'st'
    );
    const completionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        completionPosition
      );

    assert.ok(
      hasCompletionItemLabel(completionList?.items, 'state'),
      'Expected runtime-backed custom field completion to include `state`.'
    );
    const customFieldCompletionItem = findCompletionItemByLabel(
      completionList?.items,
      'state'
    );
    assert.strictEqual(
      customFieldCompletionItem?.insertText,
      'state__',
      'Expected runtime-backed custom field completion to continue lookup operators.'
    );
    assert.strictEqual(
      customFieldCompletionItem?.command?.command,
      'editor.action.triggerSuggest',
      'Expected runtime-backed custom field completion to reopen suggestions.'
    );

    const customLookupCompletionPosition = positionAfterTextInContainer(
      document,
      "Company.objects.filter(state__rea='READY')",
      'state__rea'
    );
    const customLookupCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        customLookupCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(customLookupCompletionList?.items, 'ready'),
      'Expected runtime-backed custom lookup completion to include `ready`.'
    );

    const hoverPosition = positionInsideText(
      document,
      "Company.objects.filter(state__in=['READY'])",
      'state__in'
    );
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      hoverPosition
    );
    const hoverText = stringifyHovers(hovers);

    assert.ok(
      hoverText.includes('Owner model: `blog.Company`'),
      `Expected runtime-backed custom field hover to mention blog.Company. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('Field kind: `Status`'),
      `Expected runtime-backed custom field hover to mention the custom field kind. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('Lookup operator: `in`'),
      `Expected runtime-backed custom field hover to mention the lookup operator. Received: ${hoverText}`
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) => item.message.includes('author__unknown'))
    );
    assert.ok(diagnostics.length > 0, 'Expected diagnostics to be non-empty before checking absence of valid paths');
    assert.ok(
      diagnostics.every(
        (item) => !item.message.includes("state__in")
      ),
      `Expected runtime-backed custom field lookup to avoid diagnostics. Received: ${stringifyDiagnostics(diagnostics)}`
    );
  });

  test('supports foreign key attname aliases in keyword lookups', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const fieldCompletionPosition = positionAfterTextInContainer(
      document,
      'Post.objects.filter(author_i=1)',
      'author_i'
    );
    const fieldCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        fieldCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(fieldCompletionList?.items, 'author_id'),
      'Expected foreign-key attname completion to include `author_id`.'
    );
    const attnameCompletionItem = findCompletionItemByLabel(
      fieldCompletionList?.items,
      'author_id'
    );
    assert.strictEqual(
      attnameCompletionItem?.insertText,
      'author_id__',
      'Expected foreign-key attname completion to continue lookup operators.'
    );
    assert.ok(
      Boolean(attnameCompletionItem?.detail) &&
        !attnameCompletionItem!.detail!.startsWith('Django field'),
      `Expected foreign-key attname completion detail to mention a concrete field kind. Received: ${attnameCompletionItem?.detail}`
    );

    const hoverPosition = positionInsideText(
      document,
      'Post.objects.filter(author_id__in=[1, 2])',
      'author_id__in'
    );
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      hoverPosition
    );
    const hoverText = stringifyHovers(hovers);

    assert.ok(
      hoverText.includes('Owner model: `blog.Post`'),
      `Expected foreign-key attname hover to mention blog.Post. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('Field kind: `'),
      `Expected foreign-key attname hover to mention a field kind. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('Lookup operator: `in`'),
      `Expected foreign-key attname hover to mention the lookup operator. Received: ${hoverText}`
    );

    const definitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, hoverPosition);
    const definitionTarget = firstDefinition(definitions);

    assert.ok(
      definitionTarget,
      'Expected a definition target for the foreign-key attname lookup path.'
    );
    assert.strictEqual(
      definitionTarget!.range.start.line + 1,
      68,
      'Expected foreign-key attname definition to target the Post.author field.'
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) => item.message.includes('author__unknown'))
    );
    assert.ok(diagnostics.length > 0, 'Expected diagnostics to be non-empty before checking absence of valid paths');
    assert.ok(
      diagnostics.every((item) => !item.message.includes('author_id__in')),
      `Expected foreign-key attname lookup to avoid diagnostics. Received: ${stringifyDiagnostics(diagnostics)}`
    );
  });

  test('surfaces lookup operators after a foreign key segment', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const relationFieldOperatorCompletionPosition = positionAfterTextInContainer(
      document,
      "filter(author__='mentor')",
      'author__'
    );
    const relationFieldOperatorCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        relationFieldOperatorCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(relationFieldOperatorCompletionList?.items, 'in'),
      'Expected keyword lookup completion to include `in` after a ForeignKey segment.'
    );
    assert.ok(
      hasCompletionItemLabel(relationFieldOperatorCompletionList?.items, 'exact'),
      'Expected keyword lookup completion to include `exact` after a ForeignKey segment.'
    );
    assert.ok(
      hasCompletionItemLabel(relationFieldOperatorCompletionList?.items, 'profile'),
      'Expected keyword lookup completion to still include related model fields after a ForeignKey segment.'
    );
    const relationFieldOperatorLabels = (
      relationFieldOperatorCompletionList?.items ?? []
    ).map((item) => completionItemLabel(item));
    assert.ok(
      relationFieldOperatorLabels.slice(0, 8).includes('profile'),
      `Expected \`profile\` to stay near the top after a ForeignKey segment. Received: ${relationFieldOperatorLabels.slice(0, 8).join(', ')}`
    );
  });

  test('surfaces lookup operators before typing separators', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const relationCompletionPosition = positionAfterTextInContainer(
      document,
      "filter(auth='mentor')",
      'auth'
    );
    const relationCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        relationCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(relationCompletionList?.items, 'author__in'),
      'Expected field-prefix completion to include `author__in` before typing `__`.'
    );
    assert.ok(
      hasCompletionItemLabel(relationCompletionList?.items, 'author__exact'),
      'Expected field-prefix completion to include `author__exact` before typing `__`.'
    );
    const relationCompletionLabels = (relationCompletionList?.items ?? []).map(
      (item) => completionItemLabel(item)
    );
    assert.ok(
      relationCompletionLabels.slice(0, 8).includes('author__in'),
      `Expected \`author__in\` to appear near the top of the initial suggestions. Received: ${relationCompletionLabels.slice(0, 8).join(', ')}`
    );

    const fieldCompletionPosition = positionAfterTextInContainer(
      document,
      "filter(tit='x')",
      'tit'
    );
    const fieldCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        fieldCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(fieldCompletionList?.items, 'title__in'),
      'Expected field-prefix completion to include `title__in` before typing `__`.'
    );
    assert.ok(
      hasCompletionItemLabel(fieldCompletionList?.items, 'title__endswith'),
      'Expected field-prefix completion to include `title__endswith` before typing `__`.'
    );
    const fieldCompletionLabels = (fieldCompletionList?.items ?? []).map((item) =>
      completionItemLabel(item)
    );
    assert.ok(
      fieldCompletionLabels.slice(0, 8).includes('title__in'),
      `Expected \`title__in\` to appear near the top of the initial suggestions. Received: ${fieldCompletionLabels.slice(0, 8).join(', ')}`
    );
  });

  test('surfaces lookup operators when completion opens on an empty keyword', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const blankCompletionPosition = positionAfterTextInContainer(
      document,
      'Post.objects.filter()',
      'filter('
    );
    const blankCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        blankCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(blankCompletionList?.items, 'author__in'),
      'Expected empty keyword completion to include `author__in`.'
    );
    assert.ok(
      hasCompletionItemLabel(blankCompletionList?.items, 'author__profile'),
      'Expected empty keyword completion to include eager two-segment lookup fields.'
    );
    assert.ok(
      !hasCompletionItemLabel(blankCompletionList?.items, 'author__profile__timezone'),
      'Expected empty keyword completion to stop eager lookup fields at two segments.'
    );
    assert.ok(
      hasCompletionItemLabel(blankCompletionList?.items, 'title__endswith'),
      'Expected empty keyword completion to include `title__endswith`.'
    );
    const blankRelationFieldItem = findCompletionItemByLabel(
      blankCompletionList?.items,
      'author__profile'
    );
    assert.strictEqual(
      blankRelationFieldItem?.detail,
      'OneToOneField · Author -> Profile',
      'Expected nested lookup completion detail to stay compact while showing the related model.'
    );
    assert.strictEqual(
      completionItemLabelDetail(blankRelationFieldItem!),
      ' (OneToOneField)',
      'Expected eager chained lookup completion to show the field kind inline in the suggestion list.'
    );
    assert.strictEqual(
      completionItemDescription(blankRelationFieldItem!),
      'Author -> Profile',
      'Expected eager chained lookup completion to show the owner and related model inline in the suggestion list.'
    );
    const blankCompletionLabels = (blankCompletionList?.items ?? []).map((item) =>
      completionItemLabel(item)
    );
    assert.ok(
      blankCompletionLabels.slice(0, 12).includes('author__in'),
      `Expected \`author__in\` to appear in the initial empty-prefix suggestions. Received: ${blankCompletionLabels.slice(0, 12).join(', ')}`
    );
  });

  test('filters nested lookup completions by the visible segment prefix', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const stringCompletionPosition = positionAfterTextInContainer(
      document,
      'Post.objects.values("author__pro")',
      'author__pro'
    );
    const stringCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        stringCompletionPosition
      );
    const stringFieldItem = findCompletionItemByLabel(
      stringCompletionList?.items,
      'profile'
    );
    const nestedStringCompletionPosition = positionAfterTextInContainer(
      document,
      'Post.objects.values("author__profile__timezone")',
      'author__profile__tim'
    );
    const nestedStringCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        nestedStringCompletionPosition
      );
    const stringChainedItem = findCompletionItemByLabel(
      nestedStringCompletionList?.items,
      'timezone'
    );

    assert.ok(stringFieldItem, 'Expected string lookup completion to include `profile`.');
    assert.strictEqual(
      completionItemFilterValue(stringFieldItem!),
      'author__profile',
      'Expected string lookup field completion to preserve the full lookup prefix for editor filtering.'
    );
    assert.ok(
      stringChainedItem,
      'Expected string lookup completion to include `timezone` after typing `author__profile__`.'
    );
    assert.strictEqual(
      completionItemFilterValue(stringChainedItem!),
      'author__profile__timezone',
      'Expected nested string lookup completion to preserve the full lookup prefix for editor filtering.'
    );

    const keywordCompletionPosition = positionAfterTextInContainer(
      document,
      "filter(author__pro='mentor')",
      'author__pro'
    );
    const keywordCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        keywordCompletionPosition
      );
    const keywordFieldItem = findCompletionItemByLabel(
      keywordCompletionList?.items,
      'profile'
    );

    assert.ok(keywordFieldItem, 'Expected keyword lookup completion to include `profile`.');
    assert.strictEqual(
      completionItemFilterValue(keywordFieldItem!),
      'author__profile',
      'Expected keyword lookup field completion to preserve the full lookup prefix for editor filtering.'
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
    const operatorItem = findCompletionItemByLabel(
      operatorCompletionList?.items,
      'icontains'
    );

    assert.ok(
      operatorItem,
      'Expected nested operator completion to include `icontains`.'
    );
    assert.ok(
      completionItemFilterValue(operatorItem!) ===
        'author__profile__timezone__icontains',
      `Expected nested operator completion to preserve the full lookup prefix for editor filtering. Received: ${completionItemFilterValue(operatorItem!)}`
    );
  });

  test('supports Q and F expression lookup references across queryset methods', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const qCompletionPosition = positionAfterTextInContainer(
      document,
      "Post.objects.filter(Q(author__pro='mentor'))",
      'author__pro'
    );
    const qCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        qCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(qCompletionList?.items, 'profile'),
      'Expected Q expression keyword lookup completion to include `profile`.'
    );

    const qGetCompletionPosition = positionAfterTextInContainer(
      document,
      "Post.objects.get(Q(author__pro='mentor'))",
      'author__pro'
    );
    const qGetCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        qGetCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(qGetCompletionList?.items, 'profile'),
      'Expected get(Q(...)) completion to include `profile`.'
    );

    const qExcludeCompletionPosition = positionAfterTextInContainer(
      document,
      "Post.objects.exclude(db_models.Q(author__pro='mentor'))",
      'author__pro'
    );
    const qExcludeCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        qExcludeCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(qExcludeCompletionList?.items, 'profile'),
      'Expected exclude(models.Q(...)) completion to include `profile`.'
    );

    const fCompletionPosition = positionAfterTextInContainer(
      document,
      'Post.objects.filter(title=F("author__na"))',
      'author__na'
    );
    const fCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        fCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(fCompletionList?.items, 'name'),
      'Expected F expression field-path completion to include `name`.'
    );
    const fCompletionItem = findCompletionItemByLabel(
      fCompletionList?.items,
      'name'
    );
    assert.strictEqual(
      fCompletionItem?.insertText,
      'name',
      'Expected F expression field completion to insert a terminal field segment without forcing `__`.'
    );

    const fExcludeCompletionPosition = positionAfterTextInContainer(
      document,
      'Post.objects.exclude(title=db_models.F("author__na"))',
      'author__na'
    );
    const fExcludeCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        fExcludeCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(fExcludeCompletionList?.items, 'name'),
      'Expected exclude(models.F(...)) completion to include `name`.'
    );

    const companyQCompletionPosition = positionAfterTextInContainer(
      document,
      "Company.objects.exclude(db_models.Q(st='READY'))",
      'st'
    );
    const companyQCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        companyQCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(companyQCompletionList?.items, 'state'),
      'Expected Q completion on Company to include `state`.'
    );

    const companyFCompletionPosition = positionAfterTextInContainer(
      document,
      'Company.objects.get(name=db_models.F("st"))',
      'st'
    );
    const companyFCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        companyFCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(companyFCompletionList?.items, 'state'),
      'Expected F completion on Company to include `state`.'
    );

    const auditQCompletionPosition = positionAfterTextInContainer(
      document,
      "AuditLog.objects.exclude(Q(na='entry'))",
      'na'
    );
    const auditQCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        auditQCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(auditQCompletionList?.items, 'name'),
      'Expected Q completion on AuditLog to include `name`.'
    );

    const qHoverPosition = positionInsideText(
      document,
      "Post.objects.filter(Q(author__profile__timezone='Asia/Seoul'))",
      'timezone'
    );
    const qHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      qHoverPosition
    );
    const qHoverText = stringifyHovers(qHovers);

    assert.ok(
      qHoverText.includes('Owner model: `blog.Profile`'),
      `Expected Q expression hover to mention blog.Profile. Received: ${qHoverText}`
    );
    assert.ok(
      qHoverText.includes('Field kind: `CharField`'),
      `Expected Q expression hover to mention CharField. Received: ${qHoverText}`
    );

    const qExcludeHoverPosition = positionInsideText(
      document,
      "Post.objects.exclude(db_models.Q(author__profile__timezone='Asia/Seoul'))",
      'timezone'
    );
    const qExcludeHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      qExcludeHoverPosition
    );
    const qExcludeHoverText = stringifyHovers(qExcludeHovers);

    assert.ok(
      qExcludeHoverText.includes('Owner model: `blog.Profile`'),
      `Expected exclude(models.Q(...)) hover to mention blog.Profile. Received: ${qExcludeHoverText}`
    );

    const fHoverPosition = positionInsideText(
      document,
      'Post.objects.filter(title=F("author__profile__timezone"))',
      'timezone'
    );
    const fHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      fHoverPosition
    );
    const fHoverText = stringifyHovers(fHovers);

    assert.ok(
      fHoverText.includes('Owner model: `blog.Profile`'),
      `Expected F expression hover to mention blog.Profile. Received: ${fHoverText}`
    );
    assert.ok(
      fHoverText.includes('Field kind: `CharField`'),
      `Expected F expression hover to mention CharField. Received: ${fHoverText}`
    );

    const definitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, fHoverPosition);
    const definitionTarget = firstDefinition(definitions);

    assert.ok(
      definitionTarget,
      'Expected a definition target for the F expression field path.'
    );
    assert.strictEqual(
      definitionTarget!.range.start.line + 1,
      40,
      'Expected F expression definition to target the Profile.timezone field.'
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) => item.message.includes('bogus_q')) &&
        items.some((item) => item.message.includes('bogus_f'))
    );
    assert.ok(
      diagnostics.some((item) =>
        item.message.includes('bogus_q')
      ),
      `Expected Q diagnostics to include invalid wrapped lookup paths. Received: ${stringifyDiagnostics(diagnostics)}`
    );
    assert.ok(
      diagnostics.some((item) =>
        item.message.includes('bogus_f')
      ),
      `Expected F diagnostics to include invalid wrapped lookup paths. Received: ${stringifyDiagnostics(diagnostics)}`
    );
  });

  test('supports create, update, get_or_create, and update_or_create field contexts', async function () {
    this.timeout(60_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const getOrCreateCompletionPosition = positionAfterTextInContainer(
      document,
      "Post.objects.get_or_create(author__pro='mentor')",
      'author__pro'
    );
    const getOrCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        getOrCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(getOrCreateCompletionList?.items, 'profile'),
      'Expected get_or_create() lookup completion to include `profile`.'
    );

    const updateOrCreateCompletionPosition = positionAfterTextInContainer(
      document,
      "Post.objects.update_or_create(author__pro='mentor')",
      'author__pro'
    );
    const updateOrCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        updateOrCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(updateOrCreateCompletionList?.items, 'profile'),
      'Expected update_or_create() lookup completion to include `profile`.'
    );

    const createTitleCompletionPosition = positionAfterTextInContainer(
      document,
      "Post.objects.create(ti='draft', author_i=1)",
      'ti'
    );
    const createTitleCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        createTitleCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(createTitleCompletionList?.items, 'title'),
      'Expected create() field completion to include `title`.'
    );

    const createAuthorIdCompletionPosition = positionAfterTextInContainer(
      document,
      "Post.objects.create(ti='draft', author_i=1)",
      'author_i'
    );
    const createAuthorIdCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        createAuthorIdCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(createAuthorIdCompletionList?.items, 'author_id'),
      'Expected create() field completion to include the foreign-key attname alias `author_id`.'
    );

    const createHoverPosition = positionInsideText(
      document,
      "Post.objects.create(title='draft', bog='x')",
      'title'
    );
    const createHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      createHoverPosition
    );
    const createHoverText = stringifyHovers(createHovers);

    assert.ok(
      createHoverText.includes('Owner model: `blog.Post`'),
      `Expected create() field hover to mention the owner model. Received: ${createHoverText}`
    );
    assert.ok(
      createHoverText.includes('Field kind: `CharField`'),
      `Expected create() field hover to mention the resolved field kind. Received: ${createHoverText}`
    );

    const createDefinitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, createHoverPosition);
    const createDefinitionTarget = firstDefinition(createDefinitions);

    assert.ok(
      createDefinitionTarget,
      'Expected create() field definition to resolve to the model field declaration.'
    );
    assert.ok(
      createDefinitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'minimal_project', 'blog', 'models.py')
      ),
      `Expected create() field definition to target blog/models.py. Received: ${createDefinitionTarget!.uri.fsPath}`
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) => item.message.includes('Unknown model field `bog`'))
    );

    assert.ok(
      diagnostics.some((item) =>
        item.message.includes('Unknown model field `bog`')
      ),
      `Expected create()/update() diagnostics to flag unknown direct model fields. Received: ${stringifyDiagnostics(diagnostics)}`
    );
  });

  test('supports create-like field contexts through queryset and instance-related receivers', async function () {
    this.timeout(60_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const querysetCreateCompletionPosition = positionAfterTextInContainer(
      document,
      "Post.objects.filter(published=True).create(ti='draft', author_i=1)",
      'ti'
    );
    const querysetCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        querysetCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(querysetCreateCompletionList?.items, 'title'),
      'Expected queryset-scoped create() field completion to include `title`.'
    );

    const querysetGetOrCreateCompletionPosition = positionAfterTextInContainer(
      document,
      "Post.objects.filter(published=True).get_or_create(ti='draft')",
      'ti'
    );
    const querysetGetOrCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        querysetGetOrCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(querysetGetOrCreateCompletionList?.items, 'title'),
      'Expected queryset-scoped get_or_create() field completion to include `title`.'
    );

    const querysetUpdateOrCreateCompletionPosition = positionAfterTextInContainer(
      document,
      "Post.objects.filter(published=True).update_or_create(ti='draft')",
      'ti'
    );
    const querysetUpdateOrCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        querysetUpdateOrCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(querysetUpdateOrCreateCompletionList?.items, 'title'),
      'Expected queryset-scoped update_or_create() field completion to include `title`.'
    );

    const relatedManagerCreateCompletionPosition = positionAfterTextInContainer(
      document,
      "author.posts.create(ti='draft')",
      'ti'
    );
    const relatedManagerCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        relatedManagerCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(relatedManagerCreateCompletionList?.items, 'title'),
      'Expected instance-related-manager create() field completion to include `title`.'
    );

    const relatedManagerGetOrCreateCompletionPosition = positionAfterTextInContainer(
      document,
      "author.posts.get_or_create(ti='draft')",
      'ti'
    );
    const relatedManagerGetOrCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        relatedManagerGetOrCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(relatedManagerGetOrCreateCompletionList?.items, 'title'),
      'Expected instance-related-manager get_or_create() field completion to include `title`.'
    );

    const relatedManagerUpdateOrCreateCompletionPosition =
      positionAfterTextInContainer(
        document,
        "author.posts.update_or_create(ti='draft')",
        'ti'
      );
    const relatedManagerUpdateOrCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        relatedManagerUpdateOrCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        relatedManagerUpdateOrCreateCompletionList?.items,
        'title'
      ),
      'Expected instance-related-manager update_or_create() field completion to include `title`.'
    );

    const relatedManagerCreateHoverPosition = positionInsideText(
      document,
      "author.posts.create(title='draft', bog='x')",
      'title'
    );
    const relatedManagerCreateHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        relatedManagerCreateHoverPosition
      );
    const relatedManagerCreateHoverText = stringifyHovers(
      relatedManagerCreateHovers
    );

    assert.ok(
      relatedManagerCreateHoverText.includes('Owner model: `blog.Post`'),
      `Expected related-manager create() field hover to mention blog.Post. Received: ${relatedManagerCreateHoverText}`
    );
    assert.ok(
      relatedManagerCreateHoverText.includes('Field kind: `CharField`'),
      `Expected related-manager create() field hover to mention CharField. Received: ${relatedManagerCreateHoverText}`
    );

    const relatedManagerCreateDefinitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, relatedManagerCreateHoverPosition);
    const relatedManagerCreateDefinitionTarget = firstDefinition(
      relatedManagerCreateDefinitions
    );

    assert.ok(
      relatedManagerCreateDefinitionTarget,
      'Expected related-manager create() field definition to resolve to the Post.title declaration.'
    );
    assert.ok(
      relatedManagerCreateDefinitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'minimal_project', 'blog', 'models.py')
      ),
      `Expected related-manager create() definition to target blog/models.py. Received: ${relatedManagerCreateDefinitionTarget!.uri.fsPath}`
    );

    const customRelatedManagerCreateCompletionPosition = positionAfterTextInContainer(
      document,
      "typed_company.question_thread_set.create(ti='draft')",
      'ti'
    );
    const customRelatedManagerCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        customRelatedManagerCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(customRelatedManagerCreateCompletionList?.items, 'title'),
      'Expected typed custom related-manager create() field completion to include `title`.'
    );

    const customRelatedManagerEmptyCreateCompletionPosition =
      positionAfterTextInContainer(
        document,
        'typed_company.question_thread_set.create()',
        'create('
      );
    const customRelatedManagerEmptyCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        customRelatedManagerEmptyCreateCompletionPosition
      );
    const customRelatedManagerEmptyCreateTitleItem = findCompletionItemByLabel(
      customRelatedManagerEmptyCreateCompletionList?.items,
      'title'
    );

    assert.ok(
      customRelatedManagerEmptyCreateTitleItem,
      'Expected empty create() completion to include `title` before typing a keyword prefix.'
    );
    assert.ok(
      (customRelatedManagerEmptyCreateTitleItem?.sortText ?? '').startsWith(
        '\u0000django-'
      ),
      `Expected empty create() field completion to carry high-priority Django sortText. Received: ${customRelatedManagerEmptyCreateTitleItem?.sortText}`
    );

    const customRelatedManagerMethodCompletionPosition =
      positionAfterTextInContainer(
        document,
        'typed_company.question_thread_set.create()',
        'typed_company.question_thread_set.'
      );
    const customRelatedManagerMethodCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        customRelatedManagerMethodCompletionPosition
      );
    const customRelatedManagerCreateMethodItem = findCompletionItemByLabel(
      customRelatedManagerMethodCompletionList?.items,
      'create'
    );
    const customRelatedManagerGetMethodItem = findCompletionItemByLabel(
      customRelatedManagerMethodCompletionList?.items,
      'get'
    );

    assert.ok(
      customRelatedManagerCreateMethodItem,
      'Expected related-manager method completion to surface `create` before duplicate stub items.'
    );
    assert.strictEqual(
      completionItemLabelDetail(customRelatedManagerCreateMethodItem!),
      ' -> QuestionThread',
      `Expected related-manager create() completion to expose the inferred return model inline. Received: ${completionItemLabelDetail(
        customRelatedManagerCreateMethodItem!
      )}`
    );
    assert.strictEqual(
      completionItemDescription(customRelatedManagerCreateMethodItem!),
      'QuestionThread',
      `Expected related-manager create() completion to expose the inferred model description inline. Received: ${completionItemDescription(
        customRelatedManagerCreateMethodItem!
      )}`
    );
    assert.ok(
      (customRelatedManagerCreateMethodItem?.detail ?? '').includes(
        'QuestionThreadManager'
      ),
      `Expected related-manager create() completion detail to mention the custom manager class. Received: ${customRelatedManagerCreateMethodItem?.detail}`
    );
    assert.ok(
      (customRelatedManagerCreateMethodItem?.sortText ?? '').startsWith(
        '\u0000\u0000django-'
      ),
      `Expected related-manager create() completion to keep high-priority Django sortText. Received: ${customRelatedManagerCreateMethodItem?.sortText}`
    );

    assert.ok(
      customRelatedManagerGetMethodItem,
      'Expected related-manager method completion to surface `get` before duplicate stub items.'
    );
    assert.strictEqual(
      completionItemLabelDetail(customRelatedManagerGetMethodItem!),
      ' -> QuestionThread',
      `Expected related-manager get() completion to expose the inferred return model inline. Received: ${completionItemLabelDetail(
        customRelatedManagerGetMethodItem!
      )}`
    );
    assert.strictEqual(
      completionItemDescription(customRelatedManagerGetMethodItem!),
      'QuestionThread',
      `Expected related-manager get() completion to expose the inferred model description inline. Received: ${completionItemDescription(
        customRelatedManagerGetMethodItem!
      )}`
    );
    assert.ok(
      (customRelatedManagerGetMethodItem?.sortText ?? '').startsWith(
        '\u0000\u0000django-'
      ),
      `Expected related-manager get() completion to keep high-priority Django sortText. Received: ${customRelatedManagerGetMethodItem?.sortText}`
    );

    const customRelatedManagerCreateSignaturePosition =
      positionAfterTextInContainer(
        document,
        "typed_company.question_thread_set.create(ti='draft')",
        'ti'
      );
    const customRelatedManagerCreateSignatureHelp =
      await vscode.commands.executeCommand<vscode.SignatureHelp>(
        'vscode.executeSignatureHelpProvider',
        document.uri,
        customRelatedManagerCreateSignaturePosition,
        '('
      );

    assert.ok(
      customRelatedManagerCreateSignatureHelp,
      'Expected create() signature help to resolve for typed custom related managers.'
    );
    assert.ok(
      customRelatedManagerCreateSignatureHelp!.signatures[0]?.label.includes(
        'create(*,'
      ),
      `Expected create() signature help to render an ORM-aware create signature. Received: ${customRelatedManagerCreateSignatureHelp!.signatures[0]?.label}`
    );
    assert.ok(
      customRelatedManagerCreateSignatureHelp!.signatures[0]?.label.includes(
        'title: CharField'
      ),
      `Expected create() signature help to include the model field title. Received: ${customRelatedManagerCreateSignatureHelp!.signatures[0]?.label}`
    );
    assert.ok(
      customRelatedManagerCreateSignatureHelp!.signatures[0]?.label.includes(
        '-> QuestionThread'
      ),
      `Expected create() signature help to mention the created model. Received: ${customRelatedManagerCreateSignatureHelp!.signatures[0]?.label}`
    );
    assert.strictEqual(
      activeSignatureParameterLabel(customRelatedManagerCreateSignatureHelp),
      'title: CharField',
      `Expected create() signature help to focus the inferred \`title\` parameter. Received: ${activeSignatureParameterLabel(
        customRelatedManagerCreateSignatureHelp
      )}`
    );

    const customRelatedManagerFilterCompletionPosition = positionAfterTextInContainer(
      document,
      "typed_company.question_thread_set.filter(ti='draft')",
      'ti'
    );
    const customRelatedManagerFilterCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        customRelatedManagerFilterCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(customRelatedManagerFilterCompletionList?.items, 'title'),
      'Expected typed custom related-manager filter() field completion to include `title`.'
    );

    const customRelatedManagerExcludeCompletionPosition = positionAfterTextInContainer(
      document,
      "typed_company.question_thread_set.exclude(ti='draft')",
      'ti'
    );
    const customRelatedManagerExcludeCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        customRelatedManagerExcludeCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(customRelatedManagerExcludeCompletionList?.items, 'title'),
      'Expected typed custom related-manager exclude() field completion to include `title`.'
    );

    const defaultRelatedManagerCreateCompletionPosition =
      positionAfterTextInContainer(
        document,
        "company_question_thread.message_set.create(co='draft')",
        'co'
      );
    const defaultRelatedManagerCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        defaultRelatedManagerCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(defaultRelatedManagerCreateCompletionList?.items, 'content'),
      'Expected default reverse related-manager create() field completion to include `content`.'
    );

    const defaultRelatedManagerFilterCompletionPosition =
      positionAfterTextInContainer(
        document,
        "company_question_thread.message_set.filter(co='draft')",
        'co'
      );
    const defaultRelatedManagerFilterCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        defaultRelatedManagerFilterCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(defaultRelatedManagerFilterCompletionList?.items, 'content'),
      'Expected default reverse related-manager filter() field completion to include `content`.'
    );

    const defaultRelatedManagerExcludeCompletionPosition =
      positionAfterTextInContainer(
        document,
        "company_question_thread.message_set.exclude(co='draft')",
        'co'
      );
    const defaultRelatedManagerExcludeCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        defaultRelatedManagerExcludeCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        defaultRelatedManagerExcludeCompletionList?.items,
        'content'
      ),
      'Expected default reverse related-manager exclude() field completion to include `content`.'
    );

    const typedDefaultRelatedManagerCreateCompletionPosition =
      positionAfterTextInContainer(
        document,
        "typed_question_thread.message_set.create(co='draft')",
        'co'
      );
    const typedDefaultRelatedManagerCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        typedDefaultRelatedManagerCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        typedDefaultRelatedManagerCreateCompletionList?.items,
        'content'
      ),
      'Expected typed default reverse related-manager create() field completion to include `content`.'
    );

    const typedDefaultRelatedManagerFilterCompletionPosition =
      positionAfterTextInContainer(
        document,
        "typed_question_thread.message_set.filter(co='draft')",
        'co'
      );
    const typedDefaultRelatedManagerFilterCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        typedDefaultRelatedManagerFilterCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        typedDefaultRelatedManagerFilterCompletionList?.items,
        'content'
      ),
      'Expected typed default reverse related-manager filter() field completion to include `content`.'
    );

    const typedDefaultRelatedManagerExcludeCompletionPosition =
      positionAfterTextInContainer(
        document,
        "typed_question_thread.message_set.exclude(co='draft')",
        'co'
      );
    const typedDefaultRelatedManagerExcludeCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        typedDefaultRelatedManagerExcludeCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        typedDefaultRelatedManagerExcludeCompletionList?.items,
        'content'
      ),
      'Expected typed default reverse related-manager exclude() field completion to include `content`.'
    );

    const selfAnnotatedRelatedManagerCreateCompletionPosition =
      positionAfterTextInContainer(
        document,
        "self.company.question_thread_set.create(ti='draft')",
        'ti'
      );
    const selfAnnotatedRelatedManagerCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        selfAnnotatedRelatedManagerCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        selfAnnotatedRelatedManagerCreateCompletionList?.items,
        'title'
      ),
      'Expected self-annotated reverse related-manager create() field completion to include `title`.'
    );

    const selfAnnotatedRelatedManagerFilterCompletionPosition =
      positionAfterTextInContainer(
        document,
        "self.company.question_thread_set.filter(ti='draft')",
        'ti'
      );
    const selfAnnotatedRelatedManagerFilterCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        selfAnnotatedRelatedManagerFilterCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        selfAnnotatedRelatedManagerFilterCompletionList?.items,
        'title'
      ),
      'Expected self-annotated reverse related-manager filter() field completion to include `title`.'
    );

    const selfAnnotatedRelatedManagerExcludeCompletionPosition =
      positionAfterTextInContainer(
        document,
        "self.company.question_thread_set.exclude(ti='draft')",
        'ti'
      );
    const selfAnnotatedRelatedManagerExcludeCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        selfAnnotatedRelatedManagerExcludeCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        selfAnnotatedRelatedManagerExcludeCompletionList?.items,
        'title'
      ),
      'Expected self-annotated reverse related-manager exclude() field completion to include `title`.'
    );

    const captainSelfRelatedManagerCreateCompletionPosition =
      positionAfterTextInContainer(
        document,
        "self.company.question_thread_set.create(he='captain')",
        'he'
      );
    const captainSelfRelatedManagerCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        captainSelfRelatedManagerCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        captainSelfRelatedManagerCreateCompletionList?.items,
        'help_type'
      ),
      'Expected Captain-style self.company reverse related-manager create() field completion to include `help_type`.'
    );

    const captainSelfRelatedManagerEmptyCreateCompletionPosition =
      positionAfterTextInContainer(
        document,
        'self.company.question_thread_set.create()',
        'create('
      );
    const captainSelfRelatedManagerEmptyCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        captainSelfRelatedManagerEmptyCreateCompletionPosition
      );
    const captainSelfRelatedManagerEmptyCreateHelpTypeItem = findCompletionItemByLabel(
      captainSelfRelatedManagerEmptyCreateCompletionList?.items,
      'help_type'
    );

    assert.ok(
      captainSelfRelatedManagerEmptyCreateHelpTypeItem,
      'Expected Captain-style empty create() completion to include `help_type` before typing a keyword prefix.'
    );
    assert.ok(
      (captainSelfRelatedManagerEmptyCreateHelpTypeItem?.sortText ?? '').startsWith(
        '\u0000django-'
      ),
      `Expected Captain-style empty create() field completion to carry high-priority Django sortText. Received: ${captainSelfRelatedManagerEmptyCreateHelpTypeItem?.sortText}`
    );

    const captainMismatchedAnnotationEmptyCreateCompletionPosition =
      positionAfterTextInContainer(
        document,
        'self.company.mismatched_question_thread_set.create()',
        'create('
      );
    const captainMismatchedAnnotationEmptyCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        captainMismatchedAnnotationEmptyCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        captainMismatchedAnnotationEmptyCreateCompletionList?.items,
        'actual_only'
      ),
      'Expected reverse relation target fields to win over a mismatched TYPE_CHECKING manager annotation.'
    );
    assert.ok(
      !hasCompletionItemLabel(
        captainMismatchedAnnotationEmptyCreateCompletionList?.items,
        'misleading_only'
      ),
      'Expected mismatched TYPE_CHECKING manager annotation fields not to drive create() field completion.'
    );

    const captainSelfRelatedManagerFilterCompletionPosition =
      positionAfterTextInContainer(
        document,
        "self.company.question_thread_set.filter(he='captain')",
        'he'
      );
    const captainSelfRelatedManagerFilterCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        captainSelfRelatedManagerFilterCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        captainSelfRelatedManagerFilterCompletionList?.items,
        'help_type'
      ),
      'Expected Captain-style self.company reverse related-manager filter() field completion to include `help_type`.'
    );

    const captainSelfRelatedManagerExcludeCompletionPosition =
      positionAfterTextInContainer(
        document,
        "self.company.question_thread_set.exclude(he='captain')",
        'he'
      );
    const captainSelfRelatedManagerExcludeCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        captainSelfRelatedManagerExcludeCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        captainSelfRelatedManagerExcludeCompletionList?.items,
        'help_type'
      ),
      'Expected Captain-style self.company reverse related-manager exclude() field completion to include `help_type`.'
    );

    const captainSelfRelatedManagerMemberCompletionPosition =
      positionAfterTextInContainer(
        document,
        "self.company.question_thread_set.create(he='captain')",
        'question_thread_set.'
      );
    const captainSelfRelatedManagerMemberCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        captainSelfRelatedManagerMemberCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        captainSelfRelatedManagerMemberCompletionList?.items,
        'manager_only'
      ),
      'Expected self.company reverse related-manager completion to include custom manager methods from the TYPE_CHECKING annotation.'
    );
    const captainSelfRelatedManagerCreateMethodItem = findCompletionItemByLabel(
      captainSelfRelatedManagerMemberCompletionList?.items,
      'create'
    );
    const captainSelfRelatedManagerGetMethodItem = findCompletionItemByLabel(
      captainSelfRelatedManagerMemberCompletionList?.items,
      'get'
    );

    assert.strictEqual(
      completionItemLabelDetail(captainSelfRelatedManagerCreateMethodItem!),
      ' -> CaptainQuestionThread',
      `Expected self.company reverse related-manager create() completion to expose the inferred return model inline. Received: ${completionItemLabelDetail(
        captainSelfRelatedManagerCreateMethodItem!
      )}`
    );
    assert.strictEqual(
      completionItemDescription(captainSelfRelatedManagerCreateMethodItem!),
      'CaptainQuestionThread',
      `Expected self.company reverse related-manager create() completion to expose the inferred model description inline. Received: ${completionItemDescription(
        captainSelfRelatedManagerCreateMethodItem!
      )}`
    );
    assert.ok(
      (captainSelfRelatedManagerCreateMethodItem?.detail ?? '').includes(
        'CaptainQuestionThreadManager'
      ),
      `Expected self.company reverse related-manager create() completion detail to mention the custom manager class. Received: ${captainSelfRelatedManagerCreateMethodItem?.detail}`
    );
    assert.strictEqual(
      completionItemLabelDetail(captainSelfRelatedManagerGetMethodItem!),
      ' -> CaptainQuestionThread',
      `Expected self.company reverse related-manager get() completion to expose the inferred return model inline. Received: ${completionItemLabelDetail(
        captainSelfRelatedManagerGetMethodItem!
      )}`
    );
    assert.strictEqual(
      completionItemDescription(captainSelfRelatedManagerGetMethodItem!),
      'CaptainQuestionThread',
      `Expected self.company reverse related-manager get() completion to expose the inferred model description inline. Received: ${completionItemDescription(
        captainSelfRelatedManagerGetMethodItem!
      )}`
    );

    const captainMismatchedManagerCompletionPosition =
      positionAfterTextInContainer(
        document,
        'self.company.mismatched_question_thread_set.create()',
        'mismatched_question_thread_set.'
      );
    const captainMismatchedManagerCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        captainMismatchedManagerCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        captainMismatchedManagerCompletionList?.items,
        'misleading_only'
      ),
      'Expected annotation-only reverse related-manager completion to include custom manager methods even when they are not on the model default manager.'
    );

    const captainImportedRelatedManagerCreateCompletionPosition =
      positionAfterTextInContainer(
        document,
        "self.company.imported_question_thread_set.create(he='captain_imported')",
        'he'
      );
    const captainImportedRelatedManagerCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        captainImportedRelatedManagerCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        captainImportedRelatedManagerCreateCompletionList?.items,
        'help_type'
      ),
      'Expected Captain-style imported TYPE_CHECKING manager create() field completion to include `help_type`.'
    );

    const captainImportedRelatedManagerMemberCompletionPosition =
      positionAfterTextInContainer(
        document,
        "self.company.imported_question_thread_set.create(he='captain_imported')",
        'imported_question_thread_set.'
      );
    const captainImportedRelatedManagerMemberCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        captainImportedRelatedManagerMemberCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        captainImportedRelatedManagerMemberCompletionList?.items,
        'manager_only'
      ),
      'Expected imported TYPE_CHECKING manager completion to resolve the manager class even when it is excluded from `__all__`.'
    );

    const captainMessageCreateCompletionPosition = positionAfterTextInContainer(
      document,
      `self.get_company_question_thread(
            company_question_thread_id=1
        ).message_set.create(co='captain')`,
      'co'
    );
    const captainMessageCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        captainMessageCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(captainMessageCreateCompletionList?.items, 'content'),
      'Expected Captain-style returned thread message_set create() field completion to include `content`.'
    );

    const captainMessageFilterCompletionPosition = positionAfterTextInContainer(
      document,
      `self.get_company_question_thread(
            company_question_thread_id=1
        ).message_set.filter(co='captain')`,
      'co'
    );
    const captainMessageFilterCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        captainMessageFilterCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(captainMessageFilterCompletionList?.items, 'content'),
      'Expected Captain-style returned thread message_set filter() field completion to include `content`.'
    );

    const captainMessageExcludeCompletionPosition = positionAfterTextInContainer(
      document,
      `self.get_company_question_thread(
            company_question_thread_id=1
        ).message_set.exclude(co='captain')`,
      'co'
    );
    const captainMessageExcludeCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        captainMessageExcludeCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(captainMessageExcludeCompletionList?.items, 'content'),
      'Expected Captain-style returned thread message_set exclude() field completion to include `content`.'
    );

    const captainAssignedMessageCreateCompletionPosition =
      positionAfterTextInContainer(
        document,
        "company_question_thread.message_set.create(content=content)",
        'content'
      );
    const captainAssignedMessageCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        captainAssignedMessageCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        captainAssignedMessageCreateCompletionList?.items,
        'content'
      ),
      'Expected Captain-style create()-assigned variable message_set create() field completion to include `content`.'
    );

    const captainAssignedVariableCompletionPosition =
      positionAfterTextInContainer(
        document,
        "company_question_thread.message_set.create(content=content)",
        'company_question_thread.'
      );
    const captainAssignedVariableCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        captainAssignedVariableCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        captainAssignedVariableCompletionList?.items,
        'message_set'
      ),
      'Expected Captain-style create()-assigned variable member completion to include `message_set`.'
    );

    const captainGetAssignedMessageCreateCompletionPosition =
      positionAfterTextInContainer(
        document,
        `message = company_question_thread.message_set.create(
            content=content
        )`,
        'content'
      );
    const captainGetAssignedMessageCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        captainGetAssignedMessageCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        captainGetAssignedMessageCreateCompletionList?.items,
        'content'
      ),
      'Expected Captain-style get()-assigned variable message_set create() field completion to include `content`.'
    );

    const captainGetAssignedVariableCompletionPosition =
      positionAfterTextInContainer(
        document,
        `message = company_question_thread.message_set.create(
            content=content
        )`,
        'company_question_thread.'
      );
    const captainGetAssignedVariableCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        captainGetAssignedVariableCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        captainGetAssignedVariableCompletionList?.items,
        'message_set'
      ),
      'Expected Captain-style get()-assigned variable member completion to include `message_set`.'
    );

    const inheritedManagerAssignedMessageCreateCompletionPosition =
      positionAfterTextInContainer(
        document,
        "inherited_company_question_thread.message_set.create(content=content)",
        'content'
      );
    const inheritedManagerAssignedMessageCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        inheritedManagerAssignedMessageCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        inheritedManagerAssignedMessageCreateCompletionList?.items,
        'content'
      ),
      'Expected inherited-manager create()-assigned variable message_set create() field completion to include `content`.'
    );

    const inheritedManagerAssignedVariableCompletionPosition =
      positionAfterTextInContainer(
        document,
        "inherited_company_question_thread.message_set.create(content=content)",
        'inherited_company_question_thread.'
      );
    const inheritedManagerAssignedVariableCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        inheritedManagerAssignedVariableCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        inheritedManagerAssignedVariableCompletionList?.items,
        'message_set'
      ),
      'Expected inherited-manager create()-assigned variable member completion to include `message_set`.'
    );

    const proxyManagerAssignedMessageCreateCompletionPosition =
      positionAfterTextInContainer(
        document,
        "proxy_company_question_thread.message_set.create(content=content)",
        'content'
      );
    const proxyManagerAssignedMessageCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        proxyManagerAssignedMessageCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        proxyManagerAssignedMessageCreateCompletionList?.items,
        'content'
      ),
      'Expected proxy-style create()-assigned variable message_set create() field completion to include `content`.'
    );

    const proxyManagerAssignedVariableCompletionPosition =
      positionAfterTextInContainer(
        document,
        "proxy_company_question_thread.message_set.create(content=content)",
        'proxy_company_question_thread.'
      );
    const proxyManagerAssignedVariableCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        proxyManagerAssignedVariableCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        proxyManagerAssignedVariableCompletionList?.items,
        'message_set'
      ),
      'Expected proxy-style create()-assigned variable member completion to include `message_set`.'
    );

    const captainCustomRelatedManagerCreateSignatureHelpPosition =
      positionAfterTextInContainer(
        document,
        "self.company.question_thread_set.create(he='captain')",
        'he'
      );
    const captainCustomRelatedManagerCreateSignatureHelp =
      await vscode.commands.executeCommand<vscode.SignatureHelp>(
        'vscode.executeSignatureHelpProvider',
        document.uri,
        captainCustomRelatedManagerCreateSignatureHelpPosition,
        '('
      );

    assert.ok(
      captainCustomRelatedManagerCreateSignatureHelp?.signatures?.length,
      'Expected Captain-style custom related-manager create() signature help.'
    );
    assert.ok(
      captainCustomRelatedManagerCreateSignatureHelp!.signatures[0]?.label.includes(
        'help_type: CharField'
      ),
      `Expected Captain-style create() signature help to mention the inferred \`help_type\` field. Received: ${captainCustomRelatedManagerCreateSignatureHelp!.signatures[0]?.label}`
    );
    assert.ok(
      captainCustomRelatedManagerCreateSignatureHelp!.signatures[0]?.label.includes(
        '-> CaptainQuestionThread'
      ),
      `Expected Captain-style create() signature help to mention the created model. Received: ${captainCustomRelatedManagerCreateSignatureHelp!.signatures[0]?.label}`
    );
    assert.strictEqual(
      activeSignatureParameterLabel(captainCustomRelatedManagerCreateSignatureHelp),
      'help_type: CharField',
      `Expected Captain-style create() signature help to focus the inferred \`help_type\` parameter. Received: ${activeSignatureParameterLabel(
        captainCustomRelatedManagerCreateSignatureHelp
      )}`
    );

    const captainCustomRelatedManagerFilterSignatureHelpPosition =
      positionAfterTextInContainer(
        document,
        "self.company.question_thread_set.filter(he='captain')",
        'he'
      );
    const captainCustomRelatedManagerFilterSignatureHelp =
      await vscode.commands.executeCommand<vscode.SignatureHelp>(
        'vscode.executeSignatureHelpProvider',
        document.uri,
        captainCustomRelatedManagerFilterSignatureHelpPosition,
        '('
      );

    assert.ok(
      captainCustomRelatedManagerFilterSignatureHelp?.signatures?.length,
      'Expected Captain-style custom related-manager filter() signature help.'
    );
    assert.ok(
      captainCustomRelatedManagerFilterSignatureHelp!.signatures[0]?.label.includes(
        'filter(*,'
      ),
      `Expected Captain-style filter() signature help to render an ORM-aware filter signature. Received: ${captainCustomRelatedManagerFilterSignatureHelp!.signatures[0]?.label}`
    );
    assert.ok(
      captainCustomRelatedManagerFilterSignatureHelp!.signatures[0]?.label.includes(
        'help_type: CharField'
      ),
      `Expected Captain-style filter() signature help to mention the inferred \`help_type\` field. Received: ${captainCustomRelatedManagerFilterSignatureHelp!.signatures[0]?.label}`
    );
    assert.strictEqual(
      activeSignatureParameterLabel(captainCustomRelatedManagerFilterSignatureHelp),
      'help_type: CharField',
      `Expected Captain-style filter() signature help to focus the inferred \`help_type\` parameter. Received: ${activeSignatureParameterLabel(
        captainCustomRelatedManagerFilterSignatureHelp
      )}`
    );

    const multilineInitSelfCreatePosition = positionAfterTextInContainer(
      document,
      "self.company.question_thread_set.create(ti='multiline_init')",
      'create(ti'
    );
    const multilineInitSelfCreateList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        multilineInitSelfCreatePosition
      );

    assert.ok(
      hasCompletionItemLabel(multilineInitSelfCreateList?.items, 'title'),
      'Expected multi-line __init__ self-annotated reverse related-manager create() field completion to include `title`.'
    );

    const multilineCreateAssignCreatePosition = positionAfterTextInContainer(
      document,
      "company_question_thread.message_set.create(con='multiline')",
      'con'
    );
    const multilineCreateAssignCreateList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        multilineCreateAssignCreatePosition
      );

    assert.ok(
      hasCompletionItemLabel(multilineCreateAssignCreateList?.items, 'content'),
      'Expected multi-line create() assigned variable message_set create() field completion to include `content`.'
    );

    const multilineCreateAssignFilterPosition = positionAfterTextInContainer(
      document,
      "company_question_thread.message_set.filter(con='multiline')",
      'con'
    );
    const multilineCreateAssignFilterList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        multilineCreateAssignFilterPosition
      );

    assert.ok(
      hasCompletionItemLabel(multilineCreateAssignFilterList?.items, 'content'),
      'Expected multi-line create() assigned variable message_set filter() field completion to include `content`.'
    );
  });

  test('supports Meta index and constraint field contexts', async function () {
    this.timeout(60_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/schema_examples.py'
    );

    const indexCompletionPosition = positionAfterTextInContainer(
      document,
      "fields=['co']",
      'co'
    );
    const indexCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        indexCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(indexCompletionList?.items, 'code'),
      'Expected Meta Index field completion to include `code`.'
    );

    const constraintCompletionPosition = positionAfterTextInContainer(
      document,
      "fields=['author', 'pub']",
      'pub'
    );
    const constraintCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        constraintCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(constraintCompletionList?.items, 'published'),
      'Expected Meta field-list completion to include `published`.'
    );

    const hoverPosition = positionInsideText(
      document,
      "fields=['code', 'author']",
      'code'
    );
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      hoverPosition
    );
    const hoverText = stringifyHovers(hovers);

    assert.ok(
      hoverText.includes('Owner model: `blog.SchemaExample`'),
      `Expected Meta field hover to mention the owning model. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('Field kind: `CharField`'),
      `Expected Meta field hover to mention the resolved field kind. Received: ${hoverText}`
    );

    const definitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, hoverPosition);
    const definitionTarget = bestDefinitionForFixture(definitions, 'schema_examples.py');

    assert.ok(definitionTarget, 'Expected a definition target for the Meta field.');
    assert.ok(
      definitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'minimal_project', 'blog', 'schema_examples.py')
      ),
      `Expected Meta field definition to target schema_examples.py. Received: ${definitionTarget!.uri.fsPath}`
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) =>
          item.message.includes('Unknown schema field `bog`')
        )
    );

    assert.ok(
      diagnostics.some((item) =>
        item.message.includes('Unknown schema field `bog`')
      ),
      `Expected Meta schema diagnostics to flag invalid fields. Received: ${stringifyDiagnostics(diagnostics)}`
    );
  });

  test('supports Meta constraint Q lookup paths', async function () {
    this.timeout(60_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/schema_examples.py'
    );

    const conditionCompletionPosition = positionAfterTextInContainer(
      document,
      'condition=models.Q(pub=False)',
      'pub'
    );
    const conditionCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        conditionCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(conditionCompletionList?.items, 'published'),
      'Expected Meta constraint condition completion to include `published`.'
    );

    const nestedCompletionPosition = positionAfterTextInContainer(
      document,
      "check=Q(author__na__gt='')",
      'author__na'
    );
    const nestedCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        nestedCompletionPosition
      );
    const nestedCompletionItem = findCompletionItemByLabel(
      nestedCompletionList?.items,
      'name'
    );

    assert.ok(
      nestedCompletionItem,
      'Expected Meta constraint Q completion to include the related field `name`.'
    );
    assert.strictEqual(
      completionItemFilterValue(nestedCompletionItem!),
      'author__name',
      'Expected Meta constraint Q completion to preserve the full related path for editor filtering.'
    );

    const hoverPosition = positionInsideText(
      document,
      "check=Q(author__name__gt='')",
      'name__gt'
    );
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      hoverPosition
    );
    const hoverText = stringifyHovers(hovers);

    assert.ok(
      hoverText.includes('Owner model: `blog.Author`'),
      `Expected Meta constraint Q hover to mention blog.Author. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('Field kind: `CharField`'),
      `Expected Meta constraint Q hover to mention CharField. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('Lookup operator: `gt`'),
      `Expected Meta constraint Q hover to mention the lookup operator. Received: ${hoverText}`
    );

    const definitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, hoverPosition);
    const definitionTarget = firstDefinition(definitions);

    assert.ok(
      definitionTarget,
      'Expected Meta constraint Q definition to resolve to the referenced model field.'
    );
    assert.ok(
      definitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'minimal_project', 'blog', 'models.py')
      ),
      `Expected Meta constraint Q definition to target blog/models.py. Received: ${definitionTarget!.uri.fsPath}`
    );
    assert.strictEqual(
      definitionTarget!.range.start.line + 1,
      24,
      'Expected Meta constraint Q definition to target Author.name.'
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) =>
          item.message.includes('Unknown Django lookup operator `na`')
        ) &&
        items.some((item) =>
          item.message.includes('Unknown Django lookup operator `bogus`')
        )
    );

    assert.ok(
      diagnostics.some((item) =>
        item.message.includes('Unknown Django lookup operator `na`')
      ),
      `Expected Meta constraint Q diagnostics to flag incomplete related paths. Received: ${stringifyDiagnostics(diagnostics)}`
    );
    assert.ok(
      diagnostics.some((item) =>
        item.message.includes('Unknown Django lookup operator `bogus`')
      ),
      `Expected Meta constraint Q diagnostics to flag invalid related paths. Received: ${stringifyDiagnostics(diagnostics)}`
    );
    assert.ok(diagnostics.length > 0, 'Expected diagnostics to be non-empty before checking absence of valid paths');
    assert.ok(
      diagnostics.every((item) => !item.message.includes('author__name__gt')),
      `Expected valid Meta constraint Q paths to avoid diagnostics. Received: ${stringifyDiagnostics(diagnostics)}`
    );
  });

  test('propagates write-method results and bulk_update field lists', async function () {
    this.timeout(60_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const createdPostCompletionPosition = positionAfterTextInContainer(
      document,
      'created_post = Post.objects.create(title=\'draft\', author_id=1)\n    created_post.au',
      '.au'
    );
    const createdPostCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        createdPostCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(createdPostCompletionList?.items, 'author'),
      'Expected create() results assigned to variables to resolve as model instances.'
    );

    const getOrCreateCompletionPosition = positionAfterTextInContainer(
      document,
      "found_post, was_created = Post.objects.get_or_create(title='draft', author_id=1)\n    found_post.au",
      '.au'
    );
    const getOrCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        getOrCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(getOrCreateCompletionList?.items, 'author'),
      'Expected get_or_create() tuple destructuring to propagate the model instance receiver.'
    );

    const updateOrCreateCompletionPosition = positionAfterTextInContainer(
      document,
      "updated_post, was_updated = Post.objects.update_or_create(title='draft', author_id=1)\n    updated_post.au",
      '.au'
    );
    const updateOrCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        updateOrCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(updateOrCreateCompletionList?.items, 'author'),
      'Expected update_or_create() tuple destructuring to propagate the model instance receiver.'
    );

    const bulkCreateLoopCompletionPosition = positionAfterTextInContainer(
      document,
      'for created_bulk_post in created_posts:\n        created_bulk_post.au',
      '.au'
    );
    const bulkCreateLoopCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        bulkCreateLoopCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(bulkCreateLoopCompletionList?.items, 'author'),
      'Expected bulk_create() list results to propagate model instances through loops.'
    );

    const bulkUpdateCompletionPosition = positionAfterTextInContainer(
      document,
      'Post.objects.bulk_update([post], ["tit"])',
      'tit'
    );
    const bulkUpdateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        bulkUpdateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(bulkUpdateCompletionList?.items, 'title'),
      'Expected bulk_update() field-list completion to include `title`.'
    );

    const bulkUpdateHoverPosition = positionInsideText(
      document,
      'Post.objects.bulk_update([post], ["title"])',
      'title'
    );
    const bulkUpdateHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      bulkUpdateHoverPosition
    );
    const bulkUpdateHoverText = stringifyHovers(bulkUpdateHovers);

    assert.ok(
      bulkUpdateHoverText.includes('Owner model: `blog.Post`'),
      `Expected bulk_update() field hover to mention the owner model. Received: ${bulkUpdateHoverText}`
    );

    const bulkUpdateDiagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) =>
          item.message.includes('Unknown schema field `bog`')
        ) ||
        items.some((item) =>
          item.message.includes('Unknown bulk_update field `bog`')
        )
    );

    assert.ok(
      bulkUpdateDiagnostics.some((item) =>
        item.message.includes('Unknown bulk_update field `bog`')
      ),
      `Expected bulk_update() diagnostics to flag invalid fields. Received: ${stringifyDiagnostics(bulkUpdateDiagnostics)}`
    );
  });

  test('infers multiline parenthesized assignment receivers', async function () {
    this.timeout(60_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    // Test: multiline parenthesized assignment with chained methods
    // company_question_thread = (
    //     self.company.question_thread_set.get_queryset()
    //     .exclude_deleted()
    //     .get(id=company_question_thread_id)
    // )
    // company_question_thread.me  ← should complete to message_set
    const multilineParenCompletionPosition = positionAfterTextInContainer(
      document,
      'def multiline_paren_assignment_examples(\n        self, *, company_question_thread_id: int\n    ):\n        company_question_thread = (\n            self.company.question_thread_set.get_queryset()\n            .exclude_deleted()\n            .get(id=company_question_thread_id)\n        )\n        company_question_thread.me',
      '.me'
    );
    const multilineParenCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        multilineParenCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(multilineParenCompletionList?.items, 'message_set'),
      'Expected multiline parenthesized assignment to resolve as CaptainQuestionThread instance with message_set.'
    );

    // Test: simple multiline parenthesized assignment
    // simple_result = (
    //     Post.objects.get(id=1)
    // )
    // simple_result.au  ← should complete to author
    const simpleParenPosition = positionAfterTextInContainer(
      document,
      'simple_result = (\n        Post.objects.get(id=1)\n    )\n    simple_result.au',
      '.au'
    );
    const simpleParenCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        simpleParenPosition
      );

    assert.ok(
      hasCompletionItemLabel(simpleParenCompletionList?.items, 'author'),
      'Expected simple multiline parenthesized assignment with get() to resolve as Post instance.'
    );

    // Test: chained multiline parenthesized assignment
    // chained_result = (
    //     Post.objects.filter(published=True)
    //     .first()
    // )
    // chained_result.au  ← should complete to author
    const chainedParenPosition = positionAfterTextInContainer(
      document,
      'chained_result = (\n        Post.objects.filter(published=True)\n        .first()\n    )\n    chained_result.au',
      '.au'
    );
    const chainedParenCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        chainedParenPosition
      );

    assert.ok(
      hasCompletionItemLabel(chainedParenCompletionList?.items, 'author'),
      'Expected chained multiline parenthesized assignment with first() to resolve as Post instance.'
    );
  });

  test('resolves package model re-exports when a sibling models.py file exists', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'org/query_examples.py'
    );

    const lookupCompletionPosition = positionAfterTextInContainer(
      document,
      "Vendor.objects.filter(na='demo')",
      'na'
    );
    const lookupCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        lookupCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(lookupCompletionList?.items, 'name'),
      'Expected imported package model lookup completion to include `name`.'
    );

    const qCompletionPosition = positionAfterTextInContainer(
      document,
      'Vendor.objects.exclude(Q(settlement_cycles__isnull=True) | Q(settlement_cycles=[]))',
      'settlement_cycles__isn'
    );
    const qCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        qCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(qCompletionList?.items, 'isnull'),
      `Expected Q lookup completion on the re-exported model to include \`isnull\`. Received: ${JSON.stringify(
        (qCompletionList?.items ?? []).map((item) => completionItemLabel(item))
      )}`
    );

    const instanceCompletionPosition = positionAfterText(document, 'vendor.');
    const instanceCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        instanceCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(instanceCompletionList?.items, 'name'),
      'Expected imported package model instance completion to include `name`.'
    );
    assert.ok(
      hasCompletionItemLabel(instanceCompletionList?.items, 'settlement_cycles'),
      'Expected imported package model instance completion to include `settlement_cycles`.'
    );
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
      hasCompletionItemLabel(fieldCompletionList?.items, 'profile'),
      'Expected keyword lookup completion to include `profile`.'
    );
    const fieldCompletionItem = findCompletionItemByLabel(
      fieldCompletionList?.items,
      'profile'
    );
    assert.strictEqual(
      completionItemFilterValue(fieldCompletionItem!),
      'author__profile',
      'Expected keyword lookup field completion to preserve the full lookup prefix for editor filtering.'
    );
    assert.strictEqual(
      fieldCompletionItem?.insertText,
      'profile__',
      'Expected keyword lookup relation completion to continue the `__` chain.'
    );
    assert.strictEqual(
      fieldCompletionItem?.command?.command,
      'editor.action.triggerSuggest',
      'Expected keyword lookup relation completion to reopen suggestions.'
    );

    const nestedFieldCompletionPosition = positionAfterTextInContainer(
      document,
      "filter(author__profile__timezone='Asia/Seoul')",
      'author__profile__tim'
    );
    const nestedFieldCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        nestedFieldCompletionPosition
      );
    const chainedFieldCompletionItem = findCompletionItemByLabel(
      nestedFieldCompletionList?.items,
      'timezone'
    );
    assert.strictEqual(
      completionItemFilterValue(chainedFieldCompletionItem!),
      'author__profile__timezone',
      'Expected nested keyword lookup completion to preserve the full lookup prefix for editor filtering.'
    );
    assert.strictEqual(
      chainedFieldCompletionItem?.insertText,
      'timezone__',
      'Expected nested keyword lookup completion to continue lookup operators.'
    );
    assert.strictEqual(
      chainedFieldCompletionItem?.command?.command,
      'editor.action.triggerSuggest',
      'Expected nested keyword lookup completion to reopen suggestions.'
    );

    const blankOperatorCompletionPosition = positionAfterTextInContainer(
      document,
      "Post.objects.filter(title__='x')",
      'title__'
    );
    const blankOperatorCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        blankOperatorCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(blankOperatorCompletionList?.items, 'contains'),
      'Expected blank operator completion to include `contains`.'
    );
    assert.ok(
      hasCompletionItemLabel(blankOperatorCompletionList?.items, 'gte'),
      'Expected blank operator completion to include `gte`.'
    );
    assert.ok(
      hasCompletionItemLabel(blankOperatorCompletionList?.items, 'in'),
      'Expected blank operator completion to include `in`.'
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
      hasCompletionItemLabel(inheritedBaseCompletionList?.items, 'name'),
      'Expected abstract-base model keyword lookup completion to include `name`.'
    );

    const multiInheritedCompletionPosition = positionAfterTextInContainer(
      document,
      "MultiInheritedLog.objects.filter(sl='entry')",
      'sl'
    );
    const multiInheritedCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        multiInheritedCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(multiInheritedCompletionList?.items, 'slug'),
      'Expected multiple-abstract-inheritance keyword lookup completion to include `slug`.'
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
      hasCompletionItemLabel(multilineCompletionList?.items, 'timezone'),
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
      hasCompletionItemLabel(operatorCompletionList?.items, 'icontains'),
      'Expected keyword lookup operator completion to include `icontains`.'
    );
    const operatorCompletionItem = findCompletionItemByLabel(
      operatorCompletionList?.items,
      'icontains'
    );
    assert.strictEqual(
      completionItemFilterValue(operatorCompletionItem!),
      'author__profile__timezone__icontains',
      'Expected keyword lookup operator completion to preserve the full lookup prefix for editor filtering.'
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
      40,
      'Expected keyword lookup definition to target the Profile.timezone field.'
    );
  });

  test('prioritizes lowest-class model fields for inherited instance receivers', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const auditLogCompletionPosition = positionAfterTextInContainer(
      document,
      'audit_log.',
      'audit_log.'
    );
    const auditLogCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        auditLogCompletionPosition
      );

    const auditLogLabels = (auditLogCompletionList?.items ?? []).map((item) =>
      completionItemLabel(item)
    );
    assert.deepStrictEqual(
      auditLogLabels.slice(0, 3),
      ['name', 'note', 'created_at'],
      `Expected AuditLog direct fields to come before inherited fields. Received: ${auditLogLabels
        .slice(0, 8)
        .join(', ')}`
    );
    const auditLogNameCompletionItem = findCompletionItemByLabel(
      auditLogCompletionList?.items,
      'name'
    );
    assert.strictEqual(
      completionItemLabelDetail(auditLogNameCompletionItem!),
      ' (CharField)',
      'Expected inherited-instance field completion to show the Django field kind inline in the suggestion list.'
    );
    assert.strictEqual(
      completionItemDescription(auditLogNameCompletionItem!),
      'AuditLog',
      'Expected inherited-instance field completion to show the inferred Django model inline in the suggestion list.'
    );

    const multiInheritedCompletionPosition = positionAfterTextInContainer(
      document,
      'multi_inherited_log.',
      'multi_inherited_log.'
    );
    const multiInheritedCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        multiInheritedCompletionPosition
      );

    const multiInheritedLabels = (multiInheritedCompletionList?.items ?? []).map(
      (item) => completionItemLabel(item)
    );
    assert.deepStrictEqual(
      multiInheritedLabels.slice(0, 3),
      ['title', 'created_at', 'slug'],
      `Expected MultiInheritedLog direct fields to come before inherited fields. Received: ${multiInheritedLabels
        .slice(0, 8)
        .join(', ')}`
    );
  });

  test('shows hover for self and annotated self attributes as instances', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    const selfHoverPosition = positionInsideText(
      document,
      "self.company.question_thread_set.create(ti='draft')",
      'self'
    );
    const selfHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      selfHoverPosition
    );
    const selfHoverText = stringifyHovers(selfHovers);

    assert.ok(
      selfHoverText.includes('**self**: `CompanyQuestionServiceExamples` instance'),
      `Expected self hover to resolve the enclosing service instance. Received: ${selfHoverText}`
    );
    assert.ok(
      selfHoverText.includes('Resolved symbol: `blog.query_examples.CompanyQuestionServiceExamples`'),
      `Expected self hover to mention the enclosing class symbol. Received: ${selfHoverText}`
    );
    assert.ok(
      selfHoverText.includes('Class category: `general`'),
      `Expected self hover to mark the enclosing class as general. Received: ${selfHoverText}`
    );

    const selfCompanyHoverPosition = positionInsideText(
      document,
      "self.company.question_thread_set.create(ti='draft')",
      'company'
    );
    const selfCompanyHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        selfCompanyHoverPosition
      );
    const selfCompanyHoverText = stringifyHovers(selfCompanyHovers);
    const leadingSelfCompanyHoverText = stringifyHovers(
      selfCompanyHovers?.slice(0, 2)
    );

    assert.ok(
      selfCompanyHoverText.includes('**self.company**: `Company` instance'),
      `Expected self.company hover to resolve the annotated attribute receiver. Received: ${selfCompanyHoverText}`
    );
    assert.ok(
      selfCompanyHoverText.includes('Model: `blog.Company`'),
      `Expected self.company hover to mention the resolved Django model label. Received: ${selfCompanyHoverText}`
    );
    assert.ok(
      selfCompanyHoverText.includes('Resolved symbol: `blog.models.Company`'),
      `Expected self.company hover to mention the resolved Django class symbol. Received: ${selfCompanyHoverText}`
    );
    assert.ok(
      selfCompanyHoverText.includes('Class category: `django`'),
      `Expected self.company hover to mark the resolved class as django. Received: ${selfCompanyHoverText}`
    );
    assert.ok(
      leadingSelfCompanyHoverText.includes('**self.company**: `Company` instance'),
      `Expected the Django ORM extension hover to appear among the leading hover cards. Leading hovers: ${leadingSelfCompanyHoverText}`
    );

    const customRelatedManagerHoverPosition = positionInsideText(
      document,
      "typed_company.question_thread_set.create(ti='draft')",
      'question_thread_set'
    );
    const customRelatedManagerHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        customRelatedManagerHoverPosition
      );
    const customRelatedManagerHoverText = stringifyHovers(
      customRelatedManagerHovers
    );

    assert.ok(
      customRelatedManagerHoverText.includes(
        'Member kind: `reverse_relation`'
      ),
      `Expected custom related-manager hover to keep the reverse relation member context. Received: ${customRelatedManagerHoverText}`
    );
    assert.ok(
      customRelatedManagerHoverText.includes(
        'Return annotation: `QuestionThreadManager[QuestionThread]`'
      ),
      `Expected custom related-manager hover to mention the custom manager annotation. Received: ${customRelatedManagerHoverText}`
    );
    assert.ok(
      customRelatedManagerHoverText.includes(
        'Resolved return symbol: `blog.models.QuestionThreadManager`'
      ),
      `Expected custom related-manager hover to mention the manager class symbol. Received: ${customRelatedManagerHoverText}`
    );
    assert.ok(
      customRelatedManagerHoverText.includes(
        'Return annotation model: `blog.QuestionThread`'
      ),
      `Expected custom related-manager hover to mention the managed model from the annotation. Received: ${customRelatedManagerHoverText}`
    );
    assert.ok(
      customRelatedManagerHoverText.includes('Return class kind: `manager`'),
      `Expected custom related-manager hover to mark the manager class kind. Received: ${customRelatedManagerHoverText}`
    );

    const selfCustomRelatedManagerHoverPosition = positionInsideText(
      document,
      "self.company.question_thread_set.create(he='captain')",
      'question_thread_set'
    );
    const selfCustomRelatedManagerHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        selfCustomRelatedManagerHoverPosition
      );
    const selfCustomRelatedManagerHoverText = stringifyHovers(
      selfCustomRelatedManagerHovers
    );

    assert.ok(
      selfCustomRelatedManagerHoverText.includes(
        'Return annotation: `CaptainQuestionThreadManager`'
      ),
      `Expected self.company related-manager hover to mention the TYPE_CHECKING manager annotation. Received: ${selfCustomRelatedManagerHoverText}`
    );
    assert.ok(
      selfCustomRelatedManagerHoverText.includes(
        'Resolved return symbol: `blog.models.CaptainQuestionThreadManager`'
      ),
      `Expected self.company related-manager hover to mention the custom manager class. Received: ${selfCustomRelatedManagerHoverText}`
    );
    assert.ok(
      selfCustomRelatedManagerHoverText.includes('Return class kind: `manager`'),
      `Expected self.company related-manager hover to mark the custom manager class kind. Received: ${selfCustomRelatedManagerHoverText}`
    );

    const selfImportedRelatedManagerHoverPosition = positionInsideText(
      document,
      "self.company.imported_question_thread_set.create(he='captain_imported')",
      'imported_question_thread_set'
    );
    const selfImportedRelatedManagerHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        selfImportedRelatedManagerHoverPosition
      );
    const selfImportedRelatedManagerHoverText = stringifyHovers(
      selfImportedRelatedManagerHovers
    );

    assert.ok(
      selfImportedRelatedManagerHoverText.includes(
        'Return annotation: `CaptainImportedQuestionThreadManager`'
      ),
      `Expected imported related-manager hover to mention the TYPE_CHECKING manager annotation. Received: ${selfImportedRelatedManagerHoverText}`
    );
    assert.ok(
      selfImportedRelatedManagerHoverText.includes(
        'Resolved return symbol: `blog.captain_imported.CaptainImportedQuestionThreadManager`'
      ),
      `Expected imported related-manager hover to resolve a manager excluded from __all__. Received: ${selfImportedRelatedManagerHoverText}`
    );
    assert.ok(
      selfImportedRelatedManagerHoverText.includes('Return class kind: `manager`'),
      `Expected imported related-manager hover to mark the custom manager class kind. Received: ${selfImportedRelatedManagerHoverText}`
    );

    const assignedThreadHoverPosition = positionInsideText(
      document,
      "company_question_thread.message_set.create(con='multiline')",
      'company_question_thread'
    );
    const assignedThreadHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        assignedThreadHoverPosition
      );
    const assignedThreadHoverText = stringifyHovers(assignedThreadHovers);
    const leadingAssignedThreadHoverText = stringifyHovers(
      assignedThreadHovers?.slice(0, 2)
    );

    assert.ok(
      assignedThreadHoverText.includes(
        '**company_question_thread**: `QuestionThread` instance'
      ),
      `Expected create()-assigned variable hover to resolve the created model instance. Received: ${assignedThreadHoverText}`
    );
    assert.ok(
      assignedThreadHoverText.includes('Model: `blog.QuestionThread`'),
      `Expected create()-assigned variable hover to mention the created model label. Received: ${assignedThreadHoverText}`
    );
    assert.ok(
      leadingAssignedThreadHoverText.includes(
        '**company_question_thread**: `QuestionThread` instance'
      ),
      `Expected the Django ORM extension hover to appear among the leading cards for create()-assigned variables. Leading hovers: ${leadingAssignedThreadHoverText}`
    );

    const captainAssignedThreadHoverPosition = positionInsideText(
      document,
      'return company_question_thread',
      'company_question_thread'
    );
    const captainAssignedThreadHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        captainAssignedThreadHoverPosition
      );
    const captainAssignedThreadHoverText = stringifyHovers(
      captainAssignedThreadHovers
    );
    const leadingCaptainAssignedThreadHoverText = stringifyHovers(
      captainAssignedThreadHovers?.slice(0, 2)
    );

    assert.ok(
      captainAssignedThreadHoverText.includes(
        '**company_question_thread**: `CaptainQuestionThread` instance'
      ),
      `Expected Captain-style create()-assigned variable hover to resolve the created model instance. Received: ${captainAssignedThreadHoverText}`
    );
    assert.ok(
      captainAssignedThreadHoverText.includes('Model: `blog.CaptainQuestionThread`'),
      `Expected Captain-style create()-assigned variable hover to mention the created model label. Received: ${captainAssignedThreadHoverText}`
    );
    assert.ok(
      leadingCaptainAssignedThreadHoverText.includes(
        '**company_question_thread**: `CaptainQuestionThread` instance'
      ),
      `Expected the Django ORM extension hover to appear among the leading cards for Captain-style create()-assigned variables. Leading hovers: ${leadingCaptainAssignedThreadHoverText}`
    );

    const inheritedManagerAssignedThreadHoverPosition = positionInsideText(
      document,
      'return inherited_company_question_thread',
      'inherited_company_question_thread'
    );
    const inheritedManagerAssignedThreadHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        inheritedManagerAssignedThreadHoverPosition
      );
    const inheritedManagerAssignedThreadHoverText = stringifyHovers(
      inheritedManagerAssignedThreadHovers
    );

    assert.ok(
      inheritedManagerAssignedThreadHoverText.includes(
        '**inherited_company_question_thread**: `CompanyQuestionThread` instance'
      ),
      `Expected inherited-manager create()-assigned variable hover to resolve the concrete model instance instead of the generic base manager model. Received: ${inheritedManagerAssignedThreadHoverText}`
    );
    assert.ok(
      inheritedManagerAssignedThreadHoverText.includes(
        'Model: `blog.CompanyQuestionThread`'
      ),
      `Expected inherited-manager create()-assigned variable hover to mention the concrete related model label. Received: ${inheritedManagerAssignedThreadHoverText}`
    );

    const proxyManagerAssignedThreadHoverPosition = positionInsideText(
      document,
      'return proxy_company_question_thread',
      'proxy_company_question_thread'
    );
    const proxyManagerAssignedThreadHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        proxyManagerAssignedThreadHoverPosition
      );
    const proxyManagerAssignedThreadHoverText = stringifyHovers(
      proxyManagerAssignedThreadHovers
    );

    assert.ok(
      proxyManagerAssignedThreadHoverText.includes(
        '**proxy_company_question_thread**: `ProxyCompanyQuestionThread` instance'
      ),
      `Expected proxy-style create()-assigned variable hover to resolve the concrete related model instance instead of the proxy subclass. Received: ${proxyManagerAssignedThreadHoverText}`
    );
    assert.ok(
      proxyManagerAssignedThreadHoverText.includes(
        'Model: `blog.ProxyCompanyQuestionThread`'
      ),
      `Expected proxy-style create()-assigned variable hover to mention the concrete related model label. Received: ${proxyManagerAssignedThreadHoverText}`
    );

    const createMethodHoverPosition = positionInsideText(
      document,
      "typed_company.question_thread_set.create(ti='draft')",
      'create'
    );
    const createMethodHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        createMethodHoverPosition
      );
    const createMethodHoverText = stringifyHovers(createMethodHovers);
    const leadingCreateMethodHoverText = stringifyHovers(
      createMethodHovers?.slice(0, 2)
    );
    const firstCreateMethodHoverText = stringifyHovers(
      createMethodHovers?.slice(0, 1)
    );

    assert.ok(
      createMethodHoverText.includes('**create**'),
      `Expected create() hover to include the ORM member entry. Received: ${createMethodHoverText}`
    );
    assert.ok(
      createMethodHoverText.includes('Receiver kind: `manager`'),
      `Expected create() hover to resolve against the explicit manager annotation receiver. Received: ${createMethodHoverText}`
    );
    assert.ok(
      createMethodHoverText.includes(
        'Receiver class: `blog.models.QuestionThreadManager`'
      ),
      `Expected create() hover to mention the custom manager class. Received: ${createMethodHoverText}`
    );
    assert.ok(
      createMethodHoverText.includes('Return model: `blog.QuestionThread`'),
      `Expected create() hover to mention the created model. Received: ${createMethodHoverText}`
    );
    assert.ok(
      leadingCreateMethodHoverText.includes('**create**'),
      `Expected the Django ORM extension hover to appear among the leading cards for create(). Leading hovers: ${leadingCreateMethodHoverText}`
    );
    assert.ok(
      firstCreateMethodHoverText.includes('**create**'),
      `Expected the Django ORM extension hover to be the first hover card for create(). First hover: ${firstCreateMethodHoverText}`
    );

    const filterMethodHoverPosition = positionInsideText(
      document,
      "typed_company.question_thread_set.filter(ti='draft')",
      'filter'
    );
    const filterMethodHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        filterMethodHoverPosition
      );
    const filterMethodHoverText = stringifyHovers(filterMethodHovers);
    const firstFilterMethodHoverText = stringifyHovers(
      filterMethodHovers?.slice(0, 1)
    );

    assert.ok(
      filterMethodHoverText.includes('**filter**'),
      `Expected filter() hover to include the ORM member entry. Received: ${filterMethodHoverText}`
    );
    assert.ok(
      filterMethodHoverText.includes('Return model: `blog.QuestionThread`'),
      `Expected filter() hover to mention the related queryset model. Received: ${filterMethodHoverText}`
    );
    assert.ok(
      firstFilterMethodHoverText.includes('**filter**'),
      `Expected the Django ORM extension hover to be the first hover card for filter(). First hover: ${firstFilterMethodHoverText}`
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
      hasCompletionItemLabel(stringCompletionList?.items, 'title'),
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
      hasCompletionItemLabel(keywordCompletionList?.items, 'slug'),
      'Expected queryset variable keyword lookup completion to include `slug`.'
    );
    const keywordCompletionItem = findCompletionItemByLabel(
      keywordCompletionList?.items,
      'slug'
    );
    assert.strictEqual(
      completionItemFilterValue(keywordCompletionItem!),
      'category__slug',
      'Expected queryset variable field completion to preserve the chained lookup prefix for editor filtering.'
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
      hasCompletionItemLabel(multilineKeywordList?.items, 'title'),
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
      hasCompletionItemLabel(chainedKeywordList?.items, 'slug'),
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
      hasCompletionItemLabel(chainedStringList?.items, 'title'),
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

  test('infers helper, self, cls, and super queryset receivers', async function () {
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

    const helperCompletionPosition = positionAfterTextInContainer(
      document,
      "build_products().filter(category__sl='chairs')",
      'category__sl'
    );
    const helperCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        helperCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(helperCompletionList?.items, 'slug'),
      'Expected helper function queryset completion to include `slug`.'
    );

    const selfCompletionPosition = positionAfterTextInContainer(
      document,
      "self.local_queryset().filter(category__sl='chairs')",
      'category__sl'
    );
    const selfCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        selfCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(selfCompletionList?.items, 'slug'),
      'Expected self receiver queryset completion to include `slug`.'
    );

    const superCompletionPosition = positionAfterTextInContainer(
      document,
      "super().base_queryset().filter(category__sl='chairs')",
      'category__sl'
    );
    const superCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        superCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(superCompletionList?.items, 'slug'),
      'Expected super receiver queryset completion to include `slug`.'
    );

    const clsCompletionPosition = positionAfterTextInContainer(
      document,
      "return cls.available_products().filter(category__sl='chairs')",
      'category__sl'
    );
    const clsCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        clsCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(clsCompletionList?.items, 'slug'),
      'Expected cls receiver queryset completion to include `slug`.'
    );

    const hoverPosition = positionInsideText(
      document,
      'self.local_queryset().values("category__title")',
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
      `Expected helper receiver hover to mention catalog.Category. Received: ${hoverText}`
    );
  });

  test('supports unpacked dict lookup keys in queryset and Q contexts', async function () {
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

    const dictCompletionPosition = positionAfterTextInContainer(
      document,
      'active_products.filter(**{"category__sl": \'chairs\'})',
      'category__sl'
    );
    const dictCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        dictCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(dictCompletionList?.items, 'slug'),
      'Expected unpacked dict lookup completion to include `slug`.'
    );

    const dictHoverPosition = positionInsideText(
      document,
      'active_products.filter(**{"category__title": \'chairs\'})',
      'title'
    );
    const dictHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      dictHoverPosition
    );
    const dictHoverText = stringifyHovers(dictHovers);

    assert.ok(
      dictHoverText.includes('Owner model: `catalog.Category`'),
      `Expected unpacked dict hover to mention catalog.Category. Received: ${dictHoverText}`
    );
    assert.ok(
      dictHoverText.includes('Field kind: `CharField`'),
      `Expected unpacked dict hover to mention CharField. Received: ${dictHoverText}`
    );

    const dictDefinitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, dictHoverPosition);
    const dictDefinitionTarget = firstDefinition(dictDefinitions);

    assert.ok(
      dictDefinitionTarget,
      'Expected unpacked dict definition to resolve to the model field.'
    );
    assert.ok(
      dictDefinitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'advanced_queries_project', 'catalog', 'models.py')
      ),
      `Expected unpacked dict definition to target catalog/models.py. Received: ${dictDefinitionTarget!.uri.fsPath}`
    );

    const qDictHoverPosition = positionInsideText(
      document,
      'Product.objects.filter(models.Q(**{"category__slug": \'chairs\'}))',
      'slug'
    );
    const qDictHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      qDictHoverPosition
    );
    const qDictHoverText = stringifyHovers(qDictHovers);

    assert.ok(
      qDictHoverText.includes('Owner model: `catalog.Category`'),
      `Expected Q(**{{...}}) hover to mention catalog.Category. Received: ${qDictHoverText}`
    );
  });

  test('skips diagnostics for dynamic unpacked dict lookup keys', async function () {
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

    const dynamicLookupPosition = positionInsideText(
      document,
      'active_products.filter(**{f"{dynamic_lookup}__bogus": \'chairs\'})',
      'bogus'
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) => item.message.includes('line_count__bog')) &&
        items.some((item) => item.message.includes('line_total__bog')) &&
        items.some((item) => item.message.includes('`bo`'))
    );

    assert.ok(diagnostics.length > 0, 'Expected diagnostics to be non-empty before checking absence of dynamic key diagnostics');
    assert.ok(
      diagnostics.every(
        (item) => item.range.start.line !== dynamicLookupPosition.line
      ),
      `Expected dynamic unpacked dict lookup keys to avoid diagnostics. Received: ${stringifyDiagnostics(diagnostics)}`
    );
  });

  test('isolates manager queryset and instance receiver handling in advanced fixture project', async function () {
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

    const managerCompletionPosition = positionAfterTextInContainer(
      document,
      'manager.ac',
      'manager.ac'
    );
    const managerCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        managerCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(managerCompletionList?.items, 'active'),
      'Expected manager receiver completion to keep custom manager methods.'
    );

    const querysetLookupPosition = positionAfterTextInContainer(
      document,
      "active_products.filter(category__sl='chairs')",
      'category__sl'
    );
    const querysetLookupList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        querysetLookupPosition
      );

    assert.ok(
      hasCompletionItemLabel(querysetLookupList?.items, 'slug'),
      'Expected queryset receiver lookup completion to keep related field suggestions.'
    );

    const blankInstanceCompletionPosition = positionAfterTextInContainer(
      document,
      'instance.',
      'instance.'
    );
    const blankInstanceCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        blankInstanceCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(blankInstanceCompletionList?.items, 'category'),
      'Expected blank instance receiver completions to include the relation field `category`.'
    );
  });

  test('completes manager, queryset, and model instance members without stubs', async function () {
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

    const managerCompletionPosition = positionAfterTextInContainer(
      document,
      'manager.ac',
      'manager.ac'
    );
    const managerCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        managerCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(managerCompletionList?.items, 'active'),
      'Expected manager completion to include the custom queryset-backed `active` method.'
    );

    const managerCustomCompletionPosition = positionAfterTextInContainer(
      document,
      'manager.with_li',
      'manager.with_li'
    );
    const managerCustomCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        managerCustomCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(managerCustomCompletionList?.items, 'with_line_count'),
      'Expected manager completion to include the custom queryset-backed `with_line_count` method.'
    );

    const managerCreateFieldCompletionPosition = positionAfterTextInContainer(
      document,
      "Product.objects.create(na='draft')",
      'na'
    );
    const managerCreateFieldCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        managerCreateFieldCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(managerCreateFieldCompletionList?.items, 'name'),
      `Expected custom manager create() field completion to include \`name\`. Received: ${(managerCreateFieldCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const customQuerysetCreateFieldCompletionPosition =
      positionAfterTextInContainer(
        document,
        "Product.objects.active().create(na='draft')",
        'na'
      );
    const customQuerysetCreateFieldCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        customQuerysetCreateFieldCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(customQuerysetCreateFieldCompletionList?.items, 'name'),
      `Expected custom queryset create() field completion to include \`name\`. Received: ${(customQuerysetCreateFieldCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const alternateManagerCreateFieldCompletionPosition =
      positionAfterTextInContainer(
        document,
        "Product.catalog.create(na='draft')",
        'na'
      );
    const alternateManagerCreateFieldCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        alternateManagerCreateFieldCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(alternateManagerCreateFieldCompletionList?.items, 'name'),
      `Expected alternate custom manager create() field completion to include \`name\`. Received: ${(alternateManagerCreateFieldCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const annotatedManagerCreateFieldCompletionPosition =
      positionAfterTextInContainer(
        document,
        "typed_product_manager.create(na='draft')",
        'na'
      );
    const annotatedManagerCreateFieldCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        annotatedManagerCreateFieldCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(annotatedManagerCreateFieldCompletionList?.items, 'name'),
      `Expected annotated custom manager create() field completion to include \`name\`. Received: ${(annotatedManagerCreateFieldCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const annotatedAlternateManagerCreateFieldCompletionPosition =
      positionAfterTextInContainer(
        document,
        "typed_catalog_manager.create(na='draft')",
        'na'
      );
    const annotatedAlternateManagerCreateFieldCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        annotatedAlternateManagerCreateFieldCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        annotatedAlternateManagerCreateFieldCompletionList?.items,
        'name'
      ),
      `Expected annotated alternate custom manager create() field completion to include \`name\`. Received: ${(annotatedAlternateManagerCreateFieldCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const annotatedGenericManagerCreateFieldCompletionPosition =
      positionAfterTextInContainer(
        document,
        "typed_generic_catalog_manager.create(na='draft')",
        'na'
      );
    const annotatedGenericManagerCreateFieldCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        annotatedGenericManagerCreateFieldCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        annotatedGenericManagerCreateFieldCompletionList?.items,
        'name'
      ),
      `Expected annotated generic custom manager create() field completion to include \`name\`. Received: ${(annotatedGenericManagerCreateFieldCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const annotatedQuerysetCreateFieldCompletionPosition =
      positionAfterTextInContainer(
        document,
        "typed_custom_queryset.create(na='draft')",
        'na'
      );
    const annotatedQuerysetCreateFieldCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        annotatedQuerysetCreateFieldCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(annotatedQuerysetCreateFieldCompletionList?.items, 'name'),
      `Expected annotated custom queryset create() field completion to include \`name\`. Received: ${(annotatedQuerysetCreateFieldCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const functionAnnotatedManagerCreateFieldCompletionPosition =
      positionAfterTextInContainer(
        document,
        "build_product_manager_from_string_annotation().create(na='draft')",
        'na'
      );
    const functionAnnotatedManagerCreateFieldCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        functionAnnotatedManagerCreateFieldCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        functionAnnotatedManagerCreateFieldCompletionList?.items,
        'name'
      ),
      `Expected string-annotated custom manager create() field completion to include \`name\`. Received: ${(functionAnnotatedManagerCreateFieldCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const functionAnnotatedAlternateManagerCreateFieldCompletionPosition =
      positionAfterTextInContainer(
        document,
        "build_catalog_manager_from_string_annotation().create(na='draft')",
        'na'
      );
    const functionAnnotatedAlternateManagerCreateFieldCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        functionAnnotatedAlternateManagerCreateFieldCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        functionAnnotatedAlternateManagerCreateFieldCompletionList?.items,
        'name'
      ),
      `Expected string-annotated alternate custom manager create() field completion to include \`name\`. Received: ${(functionAnnotatedAlternateManagerCreateFieldCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const functionAnnotatedGenericManagerCreateFieldCompletionPosition =
      positionAfterTextInContainer(
        document,
        "build_generic_catalog_manager_from_string_annotation().create(na='draft')",
        'na'
      );
    const functionAnnotatedGenericManagerCreateFieldCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        functionAnnotatedGenericManagerCreateFieldCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        functionAnnotatedGenericManagerCreateFieldCompletionList?.items,
        'name'
      ),
      `Expected string-annotated generic custom manager create() field completion to include \`name\`. Received: ${(functionAnnotatedGenericManagerCreateFieldCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const functionAnnotatedQuerysetCreateFieldCompletionPosition =
      positionAfterTextInContainer(
        document,
        "build_product_queryset_from_custom_annotation().create(na='draft')",
        'na'
      );
    const functionAnnotatedQuerysetCreateFieldCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        functionAnnotatedQuerysetCreateFieldCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        functionAnnotatedQuerysetCreateFieldCompletionList?.items,
        'name'
      ),
      `Expected string-annotated custom queryset create() field completion to include \`name\`. Received: ${(functionAnnotatedQuerysetCreateFieldCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const memberAnnotatedGenericManagerCreateFieldCompletionPosition =
      positionAfterTextInContainer(
        document,
        "instance.typed_catalog_manager.create(na='draft')",
        'na'
      );
    const memberAnnotatedGenericManagerCreateFieldCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        memberAnnotatedGenericManagerCreateFieldCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        memberAnnotatedGenericManagerCreateFieldCompletionList?.items,
        'name'
      ),
      `Expected member-annotated generic custom manager create() field completion to include \`name\`. Received: ${(memberAnnotatedGenericManagerCreateFieldCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const memberAnnotatedGenericManagerFilterFieldCompletionPosition =
      positionAfterTextInContainer(
        document,
        "typed_product_instance.typed_catalog_manager.filter(na='draft')",
        'na'
      );
    const memberAnnotatedGenericManagerFilterFieldCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        memberAnnotatedGenericManagerFilterFieldCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        memberAnnotatedGenericManagerFilterFieldCompletionList?.items,
        'name'
      ),
      `Expected member-annotated generic custom manager filter() field completion to include \`name\`. Received: ${(memberAnnotatedGenericManagerFilterFieldCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const memberAnnotatedGenericManagerExcludeFieldCompletionPosition =
      positionAfterTextInContainer(
        document,
        "typed_product_instance.typed_catalog_manager.exclude(na='draft')",
        'na'
      );
    const memberAnnotatedGenericManagerExcludeFieldCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        memberAnnotatedGenericManagerExcludeFieldCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        memberAnnotatedGenericManagerExcludeFieldCompletionList?.items,
        'name'
      ),
      `Expected member-annotated generic custom manager exclude() field completion to include \`name\`. Received: ${(memberAnnotatedGenericManagerExcludeFieldCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const propertyCompletionPosition = positionAfterTextInContainer(
      document,
      'fulfillment.primary_d',
      'primary_d'
    );
    const propertyCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        propertyCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(propertyCompletionList?.items, 'primary_detail'),
      'Expected instance completion to include the `@property` member `primary_detail`.'
    );

    const propertyCompletionItem = findCompletionItemByLabel(
      propertyCompletionList?.items,
      'primary_detail'
    );
    assert.strictEqual(
      propertyCompletionItem?.kind,
      vscode.CompletionItemKind.Property,
      'Expected `@property` model members to use the property completion kind.'
    );

    const propertyNestedCompletionPosition = positionAfterTextInContainer(
      document,
      'fulfillment.primary_detail.de',
      '.de'
    );
    const propertyNestedCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        propertyNestedCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(propertyNestedCompletionList?.items, 'detail_code'),
      'Expected property return annotations to propagate related model member completion.'
    );

    const querysetCompletionPosition = positionAfterTextInContainer(
      document,
      'queryset.fi',
      'queryset.fi'
    );
    const querysetCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        querysetCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(querysetCompletionList?.items, 'filter'),
      'Expected queryset completion to include the built-in `filter` method.'
    );
    assert.ok(
      hasCompletionItemLabel(querysetCompletionList?.items, 'first'),
      'Expected queryset completion to include the built-in `first` method.'
    );

    const querysetCustomCompletionPosition = positionAfterTextInContainer(
      document,
      'queryset.with_li',
      'queryset.with_li'
    );
    const querysetCustomCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        querysetCustomCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(querysetCustomCompletionList?.items, 'with_line_count'),
      'Expected queryset completion to include the custom `with_line_count` method.'
    );

    const blankInstanceCompletionPosition = positionAfterTextInContainer(
      document,
      'instance.',
      'instance.'
    );
    const blankInstanceCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        blankInstanceCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(blankInstanceCompletionList?.items, 'name'),
      'Expected blank model instance completion to include the `name` field.'
    );
    assert.ok(
      hasCompletionItemLabel(blankInstanceCompletionList?.items, 'category'),
      'Expected blank model instance completion to include the relation field `category`.'
    );

    const instanceCompletionPosition = positionAfterTextInContainer(
      document,
      'instance.na',
      'instance.na'
    );
    const instanceCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        instanceCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(instanceCompletionList?.items, 'name'),
      `Expected model instance completion to include the \`name\` field. Received: ${(instanceCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );
    assert.ok(
      hasCompletionItemLabel(instanceCompletionList?.items, 'category'),
      'Expected model instance completion to include the relation field `category`.'
    );
    const relationCompletionPosition = positionAfterTextInContainer(
      document,
      'instance.category.ti',
      'instance.category.ti'
    );
    const relationCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        relationCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(relationCompletionList?.items, 'title'),
      'Expected related model completion to include the `title` field.'
    );

    const firstRelationCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.active().first().category.ti',
      'category.ti'
    );
    const firstRelationCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        firstRelationCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(firstRelationCompletionList?.items, 'title'),
      'Expected queryset-to-instance result-shape completion to keep related field suggestions.'
    );

    const dynamicInstanceCompletionPosition = positionAfterTextInContainer(
      document,
      'dynamic_instance.',
      'dynamic_instance.'
    );
    const dynamicInstanceCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        dynamicInstanceCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(dynamicInstanceCompletionList?.items, 'name'),
      'Expected dynamically resolved instance completion to include the `name` field.'
    );

    const dynamicRelationCompletionPosition = positionAfterTextInContainer(
      document,
      'dynamic_instance.category.ti',
      'dynamic_instance.category.ti'
    );
    const dynamicRelationCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        dynamicRelationCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(dynamicRelationCompletionList?.items, 'title'),
      'Expected dynamically resolved instance relations to keep related model completion.'
    );
  });

  test('completes related managers and querysets from instance receivers', async function () {
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

    const relatedManagerCompletionPosition = positionAfterTextInContainer(
      document,
      'fulfillment.details.get_q',
      'fulfillment.details.get_q'
    );
    const relatedManagerCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        relatedManagerCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(relatedManagerCompletionList?.items, 'get_queryset'),
      `Expected reverse related manager completion to include \`get_queryset\`. Received: ${(relatedManagerCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const relatedManagerCustomCompletionPosition = positionAfterTextInContainer(
      document,
      'fulfillment.details.exclude_d',
      'fulfillment.details.exclude_d'
    );
    const relatedManagerCustomCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        relatedManagerCustomCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(relatedManagerCustomCompletionList?.items, 'exclude_deleted'),
      'Expected reverse related manager completion to include custom queryset-backed methods.'
    );

    const relatedQuerysetCustomCompletionPosition = positionAfterTextInContainer(
      document,
      'fulfillment.details.get_queryset().exclude_d',
      'exclude_d'
    );
    const relatedQuerysetCustomCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        relatedQuerysetCustomCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(relatedQuerysetCustomCompletionList?.items, 'exclude_deleted'),
      'Expected queryset completions from reverse related managers to keep custom queryset methods.'
    );

    const relatedManagerCreateCompletionPosition = positionAfterTextInContainer(
      document,
      'fulfillment.details.cre',
      'fulfillment.details.cre'
    );
    const relatedManagerCreateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        relatedManagerCreateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(relatedManagerCreateCompletionList?.items, 'create'),
      'Expected reverse related manager completion to include built-in manager methods like `create`.'
    );
    const relatedManagerCreateCompletionItem = findCompletionItemByLabel(
      relatedManagerCreateCompletionList?.items,
      'create'
    );

    assert.ok(
      (relatedManagerCreateCompletionItem?.sortText ?? '').startsWith(
        '\u0000\u0000django-'
      ),
      `Expected reverse related manager create() completion to carry high-priority Django sortText. Received: ${relatedManagerCreateCompletionItem?.sortText}`
    );
    assert.strictEqual(
      completionItemLabelDetail(relatedManagerCreateCompletionItem!),
      ' -> FulfillmentDetail',
      `Expected reverse related manager create() completion to expose the inferred return model inline. Received: ${completionItemLabelDetail(
        relatedManagerCreateCompletionItem!
      )}`
    );
    assert.strictEqual(
      completionItemDescription(relatedManagerCreateCompletionItem!),
      'FulfillmentDetail',
      `Expected reverse related manager create() completion to expose the inferred model description and avoid duplicate-label merging. Received: ${completionItemDescription(relatedManagerCreateCompletionItem!)}`
    );


    const directGetResultCompletionPosition = positionAfterTextInContainer(
      document,
      'fulfillment.details.get_queryset().exclude_deleted().get(id=1).ful',
      '.ful'
    );
    const directGetResultCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        directGetResultCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(directGetResultCompletionList?.items, 'fulfillment'),
      `Expected reverse related queryset get() chains to propagate the related model instance. Received: ${(directGetResultCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const multilineAssignedInstanceCompletionPosition = positionAfterTextInContainer(
      document,
      'detail.ful',
      'detail.ful'
    );
    const multilineAssignedInstanceCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        multilineAssignedInstanceCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(multilineAssignedInstanceCompletionList?.items, 'fulfillment'),
      `Expected multiline queryset assignments to propagate instance receivers. Received: ${(multilineAssignedInstanceCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const createdInstanceCompletionPosition = positionAfterTextInContainer(
      document,
      'created_detail.ful',
      'created_detail.ful'
    );
    const createdInstanceCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        createdInstanceCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(createdInstanceCompletionList?.items, 'fulfillment'),
      `Expected reverse related manager create() calls to propagate the created model instance. Received: ${(createdInstanceCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const selfRelatedManagerCompletionPosition = positionAfterTextInContainer(
      document,
      'self.fulfillment.details.get_q',
      'self.fulfillment.details.get_q'
    );
    const selfRelatedManagerCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        selfRelatedManagerCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(selfRelatedManagerCompletionList?.items, 'get_queryset'),
      'Expected annotated self-attribute receivers to resolve reverse related managers.'
    );

    const selfRelatedQuerysetCompletionPosition = positionAfterTextInContainer(
      document,
      'self.fulfillment.details.get_queryset().exclude_d',
      'exclude_d'
    );
    const selfRelatedQuerysetCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        selfRelatedQuerysetCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(selfRelatedQuerysetCompletionList?.items, 'exclude_deleted'),
      'Expected annotated self-attribute receivers to keep reverse queryset completions after get_queryset().'
    );
  });

  test('supports string forward-reference return annotations for receiver inference', async function () {
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

    const functionModelCompletionPosition = positionAfterTextInContainer(
      document,
      'build_fulfillment_from_string_annotation().de',
      '.de'
    );
    const functionModelCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        functionModelCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(functionModelCompletionList?.items, 'details'),
      `Expected string model return annotations to propagate instance receivers. Received: ${(functionModelCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const functionRelationCompletionPosition = positionAfterTextInContainer(
      document,
      'build_fulfillment_from_string_annotation().details.get_q',
      'get_q'
    );
    const functionRelationCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        functionRelationCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(functionRelationCompletionList?.items, 'get_queryset'),
      'Expected string model return annotations to support downstream reverse manager completions.'
    );

    const functionQuerysetCompletionPosition = positionAfterTextInContainer(
      document,
      'build_product_queryset_from_string_annotation().with_li',
      'with_li'
    );
    const functionQuerysetCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        functionQuerysetCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(functionQuerysetCompletionList?.items, 'with_line_count'),
      'Expected string queryset return annotations to propagate queryset receivers.'
    );

    const methodRelationCompletionPosition = positionAfterTextInContainer(
      document,
      'self.current_fulfillment().details.get_q',
      'get_q'
    );
    const methodRelationCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        methodRelationCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(methodRelationCompletionList?.items, 'get_queryset'),
      'Expected string method return annotations to propagate model receivers.'
    );

    const methodQuerysetCompletionPosition = positionAfterTextInContainer(
      document,
      'self.current_products().with_li',
      'with_li'
    );
    const methodQuerysetCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        methodQuerysetCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(methodQuerysetCompletionList?.items, 'with_line_count'),
      'Expected string method return annotations to propagate queryset receivers.'
    );
  });

  test('supports string forward-reference return annotations for general class instances', async function () {
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

    const functionAttributeCompletionPosition = positionAfterTextInContainer(
      document,
      'build_question_thread_message().con',
      '.con'
    );
    const functionAttributeCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        functionAttributeCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(functionAttributeCompletionList?.items, 'content'),
      `Expected string general-class return annotations to propagate annotated attributes. Received: ${(functionAttributeCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );
    const contentCompletionItem = findCompletionItemByLabel(
      functionAttributeCompletionList?.items,
      'content'
    );
    assert.ok(
      contentCompletionItem,
      'Expected to resolve the general-class attribute completion item for `content`.'
    );
    assert.strictEqual(
      completionItemLabelDetail(contentCompletionItem!),
      ' (str)',
      `Expected general-class attribute completion to expose the annotated type inline. Received: ${completionItemLabelDetail(
        contentCompletionItem!
      )}`
    );
    assert.strictEqual(
      completionItemDescription(contentCompletionItem!),
      'QuestionThreadMessage',
      `Expected general-class attribute completion to expose the owner class inline. Received: ${completionItemDescription(
        contentCompletionItem!
      )}`
    );

    const functionMethodCompletionPosition = positionAfterTextInContainer(
      document,
      'build_question_thread_message().render_p',
      '.render_p'
    );
    const functionMethodCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        functionMethodCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(functionMethodCompletionList?.items, 'render_preview'),
      'Expected string general-class return annotations to propagate instance methods.'
    );
    const renderPreviewCompletionItem = findCompletionItemByLabel(
      functionMethodCompletionList?.items,
      'render_preview'
    );
    assert.ok(
      renderPreviewCompletionItem,
      'Expected to resolve the general-class method completion item for `render_preview`.'
    );
    assert.strictEqual(
      completionItemLabelDetail(renderPreviewCompletionItem!),
      ' -> str',
      `Expected general-class method completion to expose the return annotation inline. Received: ${completionItemLabelDetail(
        renderPreviewCompletionItem!
      )}`
    );
    assert.strictEqual(
      completionItemDescription(renderPreviewCompletionItem!),
      'QuestionThreadMessage',
      `Expected general-class method completion to expose the owner class inline. Received: ${completionItemDescription(
        renderPreviewCompletionItem!
      )}`
    );

    const methodAttributeCompletionPosition = positionAfterTextInContainer(
      document,
      'message.con',
      '.con'
    );
    const methodAttributeCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        methodAttributeCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(methodAttributeCompletionList?.items, 'content'),
      `Expected self method string return annotations to propagate general-class attributes. Received: ${(methodAttributeCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const methodMethodCompletionPosition = positionAfterTextInContainer(
      document,
      'message.render_p',
      '.render_p'
    );
    const methodMethodCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        methodMethodCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(methodMethodCompletionList?.items, 'render_preview'),
      'Expected self method string return annotations to propagate general-class methods.'
    );
  });

  test('supports annotate expressions and annotated instance members in advanced fixture project', async function () {
    this.timeout(60_000);

    const fixtureRoot = path.resolve(
      __dirname,
      '../../fixtures/advanced_queries_project'
    );
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'sales/query_examples.py'
    );

    const countCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(line_count=models.Count("li"))',
      'li'
    );
    const countCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        countCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(countCompletionList?.items, 'lines'),
      'Expected Count() expression completion to include the related field `lines`.'
    );

    const annotatedLookupCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(line_count=models.Count("li")).filter(line_co=1)',
      'filter(line_co'
    );
    const annotatedLookupCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        annotatedLookupCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(annotatedLookupCompletionList?.items, 'line_count'),
      `Expected annotate() aliases to complete inside downstream queryset lookups. Received: ${(annotatedLookupCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const annotatedOperatorCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(line_count=models.Count("li")).filter(line_count__g=1)',
      'line_count__g'
    );
    const annotatedOperatorCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        annotatedOperatorCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(annotatedOperatorCompletionList?.items, 'gt'),
      'Expected annotate() aliases to surface lookup operators after the alias segment.'
    );

    const fCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(category_title=models.F("category__ti"))',
      'category__ti'
    );
    const fCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        fCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(fCompletionList?.items, 'title'),
      'Expected F() inside annotate() to include the related field `title`.'
    );

    const castCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(category_title_text=models.Cast("category__ti", output_field=models.CharField()))',
      'category__ti'
    );
    const castCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        castCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(castCompletionList?.items, 'title'),
      'Expected Cast() expression completion to include the related field `title`.'
    );

    const funcCompletionPosition = positionAfterTextInContainer(
      document,
      'category_title_lower=models.Func("category__ti", function="LOWER")',
      'category__ti'
    );
    const funcCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        funcCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(funcCompletionList?.items, 'title'),
      'Expected Func() expression completion to include the related field `title`.'
    );

    const coalesceCompletionPosition = positionAfterTextInContainer(
      document,
      'category_title_or_name=models.Coalesce("category__ti", "na")',
      'category__ti'
    );
    const coalesceCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        coalesceCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(coalesceCompletionList?.items, 'title'),
      'Expected Coalesce() expression completion to include the related field `title`.'
    );

    const expressionWrapperCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(weighted_name=models.ExpressionWrapper(models.F("na"), output_field=models.CharField()))',
      'na'
    );
    const expressionWrapperCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        expressionWrapperCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(expressionWrapperCompletionList?.items, 'name'),
      'Expected ExpressionWrapper(F(...)) to preserve the inner F() field-path completion.'
    );

    const whenCompletionPosition = positionAfterTextInContainer(
      document,
      "When(category__sl='chairs', then=Value('chairs'))",
      'category__sl'
    );
    const whenCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        whenCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(whenCompletionList?.items, 'slug'),
      'Expected When() condition lookup completion to include `slug`.'
    );

    const whenConditionCompletionPosition = positionAfterTextInContainer(
      document,
      `When(
                condition=models.Q(category__sl='chairs'),
                then=Value('chairs'),
            )`,
      'category__sl'
    );
    const whenConditionCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        whenConditionCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(whenConditionCompletionList?.items, 'slug'),
      'Expected When(condition=Q(...)) completion to include `slug`.'
    );

    const outerRefCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.filter(pk=models.OuterRef("na")).values("category__sl")[:1]',
      'na'
    );
    const outerRefCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        outerRefCompletionPosition
      );

    const outerRefCompletionItem = (outerRefCompletionList?.items ?? []).find(
      (item) =>
        completionItemLabel(item) === 'name' &&
        item.detail === 'CharField · Product'
    );
    assert.ok(
      outerRefCompletionItem,
      `Expected OuterRef() completion to include the outer queryset field \`name\`. Received: ${(outerRefCompletionList?.items ?? [])
        .slice(0, 20)
        .map((item) => `${completionItemDisplayLabel(item)} | ${item.detail ?? '<no detail>'}`)
        .join(', ')}`
    );

    const outerRefHoverPosition = positionInsideText(
      document,
      'Product.objects.filter(pk=models.OuterRef("name")).values("category__sl")[:1]',
      'name'
    );
    const outerRefHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      outerRefHoverPosition
    );
    const outerRefHoverText = stringifyHovers(outerRefHovers);

    assert.ok(
      outerRefHoverText.includes('Owner model: `sales.Product`'),
      `Expected OuterRef() hover to mention the outer queryset model. Received: ${outerRefHoverText}`
    );
    assert.ok(
      outerRefHoverText.includes('Field kind: `CharField`'),
      `Expected OuterRef() hover to mention the resolved field kind. Received: ${outerRefHoverText}`
    );

    const outerRefDefinitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, outerRefHoverPosition);
    const outerRefDefinitionTarget = firstDefinition(outerRefDefinitions);

    assert.ok(
      outerRefDefinitionTarget,
      'Expected OuterRef() definition to resolve to the referenced outer model field.'
    );

    const aggregateCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.aggregate(line_total=models.Count("li"))',
      'li'
    );
    const aggregateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        aggregateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(aggregateCompletionList?.items, 'lines'),
      'Expected aggregate Count() expression completion to include the related field `lines`.'
    );

    const aggregateHoverPosition = positionInsideText(
      document,
      'Product.objects.aggregate(line_total=models.Count("lines"))',
      'lines'
    );
    const aggregateHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      aggregateHoverPosition
    );
    const aggregateHoverText = stringifyHovers(aggregateHovers);

    assert.ok(
      aggregateHoverText.includes('Owner model: `sales.Product`'),
      `Expected aggregate Count() hover to mention the owner model. Received: ${aggregateHoverText}`
    );

    const annotatedInstanceCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.active().annotate(line_count=models.Count("lines")).first().li',
      '.li'
    );
    const annotatedInstanceCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        annotatedInstanceCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(annotatedInstanceCompletionList?.items, 'line_count'),
      'Expected annotated instance completion to include the `line_count` alias.'
    );

    const annotatedLineCountItem = findCompletionItemByLabel(
      annotatedInstanceCompletionList?.items,
      'line_count'
    );
    assert.ok(
      annotatedLineCountItem,
      'Expected annotated instance completion to include a concrete `line_count` item.'
    );

    const customAnnotatedCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.active().with_line_count().first().li',
      '.li'
    );
    const customAnnotatedCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        customAnnotatedCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(customAnnotatedCompletionList?.items, 'line_count'),
      'Expected custom queryset methods that return annotate() results to keep annotated instance members.'
    );

    const existsAnnotatedCompletionPosition = positionAfterTextInContainer(
      document,
      "Product.objects.annotate(has_active_category=models.Exists(Product.objects.filter(pk=models.OuterRef(\"pk\"), category__sl='chairs'))).first().ha",
      '.ha'
    );
    const existsAnnotatedCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        existsAnnotatedCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        existsAnnotatedCompletionList?.items,
        'has_active_category'
      ),
      'Expected Exists() annotations to propagate onto annotated instance completions.'
    );

    const existsItem = findCompletionItemByLabel(
      existsAnnotatedCompletionList?.items,
      'has_active_category'
    );
    assert.strictEqual(
      completionItemLabelDetail(existsItem!),
      ' (BooleanField)',
      'Expected Exists() annotated instance completions to expose a BooleanField kind inline in the suggestion list.'
    );
    assert.strictEqual(
      completionItemDescription(existsItem!),
      'Product',
      'Expected Exists() annotated instance completions to expose the inferred receiver model inline in the suggestion list.'
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) => item.message.includes('line_count__bog')) &&
        items.some((item) => item.message.includes('line_total__bog')) &&
        items.some((item) => item.message.includes('`bo`'))
    );

    assert.ok(
      diagnostics.some((item) => item.message.includes('line_count__bog')),
      `Expected annotate() alias diagnostics to flag invalid lookup operators. Received: ${stringifyDiagnostics(diagnostics)}`
    );
    assert.ok(
      diagnostics.some((item) => item.message.includes('line_total__bog')),
      `Expected alias() diagnostics to flag invalid lookup operators. Received: ${stringifyDiagnostics(diagnostics)}`
    );
    assert.ok(
      diagnostics.some((item) => item.message.includes('`bo`')),
      `Expected expression diagnostics to flag invalid aggregate or OuterRef paths. Received: ${stringifyDiagnostics(diagnostics)}`
    );
  });

  test('supports relation-valued OuterRef field paths in subqueries', async function () {
    this.timeout(60_000);

    const fixtureRoot = path.resolve(
      __dirname,
      '../../fixtures/advanced_queries_project'
    );
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'sales/query_examples.py'
    );

    const relationOuterRefCompletionPosition = positionAfterTextInContainer(
      document,
      'FulfillmentDetail.objects.annotate(detail_reference=models.Subquery(Fulfillment.objects.filter(pk=models.OuterRef("ful")).values("re")[:1]))',
      'ful'
    );
    const relationOuterRefCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        relationOuterRefCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(relationOuterRefCompletionList?.items, 'fulfillment'),
      'Expected OuterRef() completion to include relation-valued outer queryset fields.'
    );
    const relationOuterRefCompletionItem = (
      relationOuterRefCompletionList?.items ?? []
    ).find(
      (item) =>
        completionItemLabel(item) === 'fulfillment' &&
        item.detail === 'ForeignKey · FulfillmentDetail -> Fulfillment'
    );
    assert.ok(
      relationOuterRefCompletionItem,
      `Expected a concrete OuterRef() completion item for the outer relation field. Received: ${(relationOuterRefCompletionList?.items ?? [])
        .slice(0, 20)
        .map((item) => `${completionItemDisplayLabel(item)} | ${item.detail ?? '<no detail>'}`)
        .join(', ')}`
    );

    const relationOuterRefHoverPosition = positionInsideText(
      document,
      'FulfillmentDetail.objects.annotate(detail_reference=models.Subquery(Fulfillment.objects.filter(pk=models.OuterRef("fulfillment")).values("re")[:1]))',
      'fulfillment'
    );
    const relationOuterRefHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        relationOuterRefHoverPosition
      );
    const relationOuterRefHoverText = stringifyHovers(relationOuterRefHovers);

    assert.ok(
      relationOuterRefHoverText.includes('Owner model: `sales.FulfillmentDetail`'),
      `Expected relation OuterRef() hover to mention the outer queryset model. Received: ${relationOuterRefHoverText}`
    );
    assert.ok(
      relationOuterRefHoverText.includes('Base model: `sales.FulfillmentDetail`'),
      `Expected relation OuterRef() hover to resolve against the outer queryset base model. Received: ${relationOuterRefHoverText}`
    );
    assert.ok(
      relationOuterRefHoverText.includes('Field kind: `ForeignKey`'),
      `Expected relation OuterRef() hover to mention the foreign-key field kind. Received: ${relationOuterRefHoverText}`
    );
    assert.ok(
      relationOuterRefHoverText.includes('Related model: `sales.Fulfillment`'),
      `Expected relation OuterRef() hover to mention the related model. Received: ${relationOuterRefHoverText}`
    );

    const relationOuterRefDefinitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >(
      'vscode.executeDefinitionProvider',
      document.uri,
      relationOuterRefHoverPosition
    );
    const relationOuterRefDefinitionTarget = firstDefinition(
      relationOuterRefDefinitions
    );

    assert.ok(
      relationOuterRefDefinitionTarget,
      'Expected relation OuterRef() definition to resolve to the referenced outer model field.'
    );
    assert.strictEqual(
      path.basename(relationOuterRefDefinitionTarget!.uri.fsPath),
      'models.py',
      'Expected relation OuterRef() definition to land in sales/models.py.'
    );
    assert.strictEqual(
      relationOuterRefDefinitionTarget!.range.start.line + 1,
      55,
      'Expected relation OuterRef() definition to target FulfillmentDetail.fulfillment.'
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) => items.some((item) => item.message.includes('`bo`'))
    );

    assert.ok(diagnostics.length > 0, 'Expected diagnostics to be non-empty before checking absence of valid paths');
    assert.ok(
      diagnostics.every((item) => !item.message.includes('`fulfillment`')),
      `Expected relation-valued OuterRef() paths to avoid diagnostics. Received: ${stringifyDiagnostics(diagnostics)}`
    );
  });

  test('supports captain-style aggregate and window expression field paths', async function () {
    this.timeout(60_000);

    const fixtureRoot = path.resolve(
      __dirname,
      '../../fixtures/advanced_queries_project'
    );
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'sales/query_examples.py'
    );

    const arrayAggCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(line_quantities=expr.ArrayAgg("li"))',
      'li'
    );
    const arrayAggCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        arrayAggCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(arrayAggCompletionList?.items, 'lines'),
      'Expected ArrayAgg() expression completion to include the related field `lines`.'
    );

    const jsonbAggCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(names=expr.JSONBAgg("na"))',
      'na'
    );
    const jsonbAggCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        jsonbAggCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(jsonbAggCompletionList?.items, 'name'),
      'Expected JSONBAgg() expression completion to include the `name` field.'
    );

    const arraySubqueryCompletionPosition = positionAfterTextInContainer(
      document,
      'LineItem.objects.filter(product_id=models.OuterRef("pk")).values("qu")',
      'qu'
    );
    const arraySubqueryCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        arraySubqueryCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(arraySubqueryCompletionList?.items, 'quantity'),
      'Expected ArraySubquery(...values()) to keep queryset string-path completion.'
    );

    const lagCompletionPosition = positionAfterTextInContainer(
      document,
      'expression=expr.Lag("customer_na")',
      'customer_na'
    );
    const lagCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        lagCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(lagCompletionList?.items, 'customer_name'),
      'Expected Lag() completion inside Window() to include `customer_name`.'
    );

    const windowPartitionCompletionPosition = positionAfterTextInContainer(
      document,
      'partition_by=[models.F("customer_na")]',
      'customer_na'
    );
    const windowPartitionCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        windowPartitionCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(windowPartitionCompletionList?.items, 'customer_name'),
      'Expected F() completion inside Window(partition_by=...) to include `customer_name`.'
    );

    const lagHoverPosition = positionInsideText(
      document,
      'expression=expr.Lag("customer_name")',
      'customer_name'
    );
    const lagHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      lagHoverPosition
    );
    const lagHoverText = stringifyHovers(lagHovers);

    assert.ok(
      lagHoverText.includes('Owner model: `sales.Order`'),
      `Expected Lag() hover to mention sales.Order. Received: ${lagHoverText}`
    );
    assert.ok(
      lagHoverText.includes('Field kind: `CharField`'),
      `Expected Lag() hover to mention CharField. Received: ${lagHoverText}`
    );

    const lagDefinitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, lagHoverPosition);
    const lagDefinitionTarget = firstDefinition(lagDefinitions);

    assert.ok(
      lagDefinitionTarget,
      'Expected Lag() definitions to resolve to the referenced model field.'
    );
    assert.ok(
      lagDefinitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'advanced_queries_project', 'sales', 'models.py')
      ),
      `Expected Lag() definition to target sales/models.py. Received: ${lagDefinitionTarget!.uri.fsPath}`
    );
    assert.strictEqual(
      lagDefinitionTarget!.range.start.line + 1,
      27,
      'Expected Lag() definition to target Order.customer_name.'
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) => item.message.includes('lines__quantitx')) &&
        items.some((item) => item.message.includes('customer_bo'))
    );

    assert.ok(
      diagnostics.some((item) => item.message.includes('lines__quantitx')),
      `Expected ArrayAgg() diagnostics to flag invalid related field paths. Received: ${stringifyDiagnostics(diagnostics)}`
    );
    assert.ok(
      diagnostics.some((item) => item.message.includes('customer_bo')),
      `Expected Window(Lag()) diagnostics to flag invalid field paths. Received: ${stringifyDiagnostics(diagnostics)}`
    );
  });

  test('supports captain-style keyword and later-argument expression field paths', async function () {
    this.timeout(60_000);

    const fixtureRoot = path.resolve(
      __dirname,
      '../../fixtures/advanced_queries_project'
    );
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'sales/query_examples.py'
    );

    const jsonObjectCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(payload=expr.JSONObject(name="na"))',
      'na'
    );
    const jsonObjectCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        jsonObjectCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(jsonObjectCompletionList?.items, 'name'),
      'Expected JSONObject(keyword="...") completion to include the `name` field.'
    );

    const jsonObjectNestedCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(payload=expr.JSONObject(name="name", category_title="category__ti"))',
      'category__ti'
    );
    const jsonObjectNestedCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        jsonObjectNestedCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(jsonObjectNestedCompletionList?.items, 'title'),
      'Expected JSONObject keyword values to keep nested related field completion.'
    );

    const greatestCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(best_name=expr.Greatest(models.Value(""), "na"))',
      'na'
    );
    const greatestCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        greatestCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(greatestCompletionList?.items, 'name'),
      'Expected Greatest(..., "...") completion to include the `name` field.'
    );

    const collateCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(sort_name=expr.Collate("na", "C"))',
      'na'
    );
    const collateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        collateCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(collateCompletionList?.items, 'name'),
      'Expected Collate() completion to include the `name` field.'
    );

    const extractCompletionPosition = positionAfterTextInContainer(
      document,
      'Order.objects.annotate(created_year=expr.Extract("created_", "year"))',
      'created_'
    );
    const extractCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        extractCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(extractCompletionList?.items, 'created_at'),
      'Expected Extract() completion to include the `created_at` field.'
    );

    const greatestHoverPosition = positionInsideText(
      document,
      'Product.objects.annotate(best_name=expr.Greatest(models.Value(""), "name"))',
      'name'
    );
    const greatestHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      greatestHoverPosition
    );
    const greatestHoverText = stringifyHovers(greatestHovers);

    assert.ok(
      greatestHoverText.includes('Owner model: `sales.Product`'),
      `Expected Greatest(..., "...") hover to mention sales.Product. Received: ${greatestHoverText}`
    );
    assert.ok(
      greatestHoverText.includes('Field kind: `CharField`'),
      `Expected Greatest(..., "...") hover to mention CharField. Received: ${greatestHoverText}`
    );

    const greatestDefinitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, greatestHoverPosition);
    const greatestDefinitionTarget = firstDefinition(greatestDefinitions);

    assert.ok(
      greatestDefinitionTarget,
      'Expected Greatest(..., "...") definitions to resolve to the referenced model field.'
    );
    assert.ok(
      greatestDefinitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'advanced_queries_project', 'sales', 'models.py')
      ),
      `Expected Greatest(..., "...") definition to target sales/models.py. Received: ${greatestDefinitionTarget!.uri.fsPath}`
    );
    assert.strictEqual(
      greatestDefinitionTarget!.range.start.line + 1,
      19,
      'Expected Greatest(..., "...") definition to target Product.name.'
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) => item.message.includes('best_name=expr.Greatest') || item.message.includes('`nax`')) &&
        items.some((item) => item.message.includes('payload=expr.JSONObject') || item.message.includes('`nax`'))
    );

    assert.ok(
      diagnostics.some((item) => item.message.includes('`nax` in `nax`') || item.message.includes('`nax`')),
      `Expected expression diagnostics to flag invalid JSONObject()/Greatest() field paths. Received: ${stringifyDiagnostics(diagnostics)}`
    );
  });

  test('supports dotted and variant captain expression field paths', async function () {
    this.timeout(60_000);

    const fixtureRoot = path.resolve(
      __dirname,
      '../../fixtures/advanced_queries_project'
    );
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'sales/query_examples.py'
    );

    const replaceCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(normalized_name=models.functions.Replace("na", models.Value("-"), models.Value("")))',
      'na'
    );
    const replaceCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        replaceCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(replaceCompletionList?.items, 'name'),
      'Expected models.functions.Replace() completion to include the `name` field.'
    );

    const substrCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(initials=expr.Substr("na", 1, 2))',
      'na'
    );
    const substrCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        substrCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(substrCompletionList?.items, 'name'),
      'Expected Substr() completion to include the `name` field.'
    );

    const leastCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(short_name=expr.Least(models.Value("zzz"), "na"))',
      'na'
    );
    const leastCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        leastCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(leastCompletionList?.items, 'name'),
      'Expected Least(..., "...") completion to include the `name` field.'
    );

    const extractYearCompletionPosition = positionAfterTextInContainer(
      document,
      'Order.objects.annotate(created_year_value=expr.ExtractYear("created_"))',
      'created_'
    );
    const extractYearCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        extractYearCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(extractYearCompletionList?.items, 'created_at'),
      'Expected ExtractYear() completion to include the `created_at` field.'
    );

    const replaceHoverPosition = positionInsideText(
      document,
      'Product.objects.annotate(normalized_name=models.functions.Replace("name", models.Value("-"), models.Value("")))',
      'name'
    );
    const replaceHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      replaceHoverPosition
    );
    const replaceHoverText = stringifyHovers(replaceHovers);

    assert.ok(
      replaceHoverText.includes('Owner model: `sales.Product`'),
      `Expected Replace() hover to mention sales.Product. Received: ${replaceHoverText}`
    );
    assert.ok(
      replaceHoverText.includes('Field kind: `CharField`'),
      `Expected Replace() hover to mention CharField. Received: ${replaceHoverText}`
    );

    const replaceDefinitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, replaceHoverPosition);
    const replaceDefinitionTarget = firstDefinition(replaceDefinitions);

    assert.ok(
      replaceDefinitionTarget,
      'Expected Replace() definitions to resolve to the referenced model field.'
    );
    assert.ok(
      replaceDefinitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'advanced_queries_project', 'sales', 'models.py')
      ),
      `Expected Replace() definition to target sales/models.py. Received: ${replaceDefinitionTarget!.uri.fsPath}`
    );
    assert.strictEqual(
      replaceDefinitionTarget!.range.start.line + 1,
      19,
      'Expected Replace() definition to target Product.name.'
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) => item.message.includes('`nax`'))
    );

    assert.ok(
      diagnostics.some((item) => item.message.includes('`nax`')),
      `Expected dotted/variant expression diagnostics to flag invalid Replace()/Substr()/Least() field paths. Received: ${stringifyDiagnostics(diagnostics)}`
    );
  });

  test('propagates custom queryset annotation aliases into downstream lookups', async function () {
    this.timeout(60_000);

    const fixtureRoot = path.resolve(
      __dirname,
      '../../fixtures/advanced_queries_project'
    );
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'sales/query_examples.py'
    );

    const customLookupCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.active().with_line_count().filter(line_co=1)',
      'filter(line_co'
    );
    const customLookupCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        customLookupCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(customLookupCompletionList?.items, 'line_count'),
      `Expected custom queryset methods that wrap annotate() to preserve alias lookup completion. Received: ${(customLookupCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );
  });

  test('supports alias lookups, ordering, and aggregate field definitions', async function () {
    this.timeout(60_000);

    const fixtureRoot = path.resolve(
      __dirname,
      '../../fixtures/advanced_queries_project'
    );
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'sales/query_examples.py'
    );

    const aliasLookupCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.alias(line_total=models.Count("li")).filter(line_to=1)',
      'filter(line_to'
    );
    const aliasLookupCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        aliasLookupCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(aliasLookupCompletionList?.items, 'line_total'),
      `Expected alias() keyword aliases to complete inside downstream queryset lookups. Received: ${(aliasLookupCompletionList?.items ?? [])
        .map((item) => completionItemLabel(item))
        .slice(0, 20)
        .join(', ')}`
    );

    const aliasOrderByCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.alias(line_total=models.Count("li")).order_by("line_to")',
      'line_to'
    );
    const aliasOrderByCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        aliasOrderByCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(aliasOrderByCompletionList?.items, 'line_total'),
      'Expected alias() keyword aliases to complete inside downstream order_by() paths.'
    );

    const aliasHoverPosition = positionInsideText(
      document,
      'Product.objects.alias(line_total=models.Count("lines")).filter(line_total__gt=1)',
      'line_total__gt'
    );
    const aliasHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      aliasHoverPosition
    );
    const aliasHoverText = stringifyHovers(aliasHovers);

    assert.ok(
      aliasHoverText.includes('Owner model: `sales.Product`'),
      `Expected alias() lookup hover to mention the owner model. Received: ${aliasHoverText}`
    );
    assert.ok(
      aliasHoverText.includes('Field kind: `IntegerField`'),
      `Expected alias() lookup hover to mention the inferred Count() field kind. Received: ${aliasHoverText}`
    );

    const aggregateDefinitionPosition = positionInsideText(
      document,
      'Product.objects.aggregate(line_total=models.Count("lines"))',
      'lines'
    );
    const aggregateDefinitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, aggregateDefinitionPosition);
    const aggregateDefinitionTarget = firstDefinition(aggregateDefinitions);

    assert.ok(
      aggregateDefinitionTarget,
      'Expected aggregate() expression definitions to resolve to the referenced model field.'
    );
    assert.ok(
      aggregateDefinitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'advanced_queries_project', 'sales', 'models.py')
      ),
      `Expected aggregate() definition to target sales/models.py. Received: ${aggregateDefinitionTarget!.uri.fsPath}`
    );
    assert.strictEqual(
      aggregateDefinitionTarget!.range.start.line + 1,
      37,
      'Expected aggregate() definition to target the LineItem.product field that defines the reverse `lines` relation.'
    );
  });

  test('propagates scalar and nested expression aliases onto annotated instances', async function () {
    this.timeout(60_000);

    const fixtureRoot = path.resolve(
      __dirname,
      '../../fixtures/advanced_queries_project'
    );
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'sales/query_examples.py'
    );

    const sumCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(total_quantity=models.Sum("lines__quantity")).first().to',
      'first().to'
    );
    const sumCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        sumCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(sumCompletionList?.items, 'total_quantity'),
      'Expected Sum() aliases to propagate onto annotated instances.'
    );

    const avgCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(avg_quantity=models.Avg("lines__quantity")).first().av',
      'first().av'
    );
    const avgCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        avgCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(avgCompletionList?.items, 'avg_quantity'),
      'Expected Avg() aliases to propagate onto annotated instances.'
    );

    const minCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(first_name=models.Min("name")).first().fi',
      'first().fi'
    );
    const minCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        minCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(minCompletionList?.items, 'first_name'),
      'Expected Min() aliases to propagate onto annotated instances.'
    );

    const maxCompletionPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(last_name=models.Max("name")).first().la',
      'first().la'
    );
    const maxCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        maxCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(maxCompletionList?.items, 'last_name'),
      'Expected Max() aliases to propagate onto annotated instances.'
    );

    const caseCompletionPosition = positionAfterTextInContainer(
      document,
      "Product.objects.annotate(category_bucket=Case(When(category__sl='chairs', then=Value('chairs')), default=Value('other'))).first().ca",
      'first().ca'
    );
    const caseCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        caseCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(caseCompletionList?.items, 'category_bucket'),
      'Expected Case()/When() aliases to propagate onto annotated instances.'
    );

    const castAliasPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(category_title_text=models.Cast("category__ti", output_field=models.CharField())).first().ca_t',
      'first().ca_t'
    );
    const castAliasList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        castAliasPosition
      );

    assert.ok(
      hasCompletionItemLabel(castAliasList?.items, 'category_title_text'),
      'Expected Cast() aliases to propagate onto annotated instances.'
    );

    const funcAliasPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(category_title_lower=models.Func("category__ti", function="LOWER")).first().ca_t_l',
      'first().ca_t_l'
    );
    const funcAliasList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        funcAliasPosition
      );

    assert.ok(
      hasCompletionItemLabel(funcAliasList?.items, 'category_title_lower'),
      'Expected Func() aliases to propagate onto annotated instances.'
    );

    const coalesceAliasPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(category_title_or_name=models.Coalesce("category__ti", "na")).first().ca_t_o',
      'first().ca_t_o'
    );
    const coalesceAliasList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        coalesceAliasPosition
      );

    assert.ok(
      hasCompletionItemLabel(coalesceAliasList?.items, 'category_title_or_name'),
      'Expected Coalesce() aliases to propagate onto annotated instances.'
    );

    const expressionWrapperAliasPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(weighted_name=models.ExpressionWrapper(models.F("na"), output_field=models.CharField())).first().we',
      'first().we'
    );
    const expressionWrapperAliasList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        expressionWrapperAliasPosition
      );

    assert.ok(
      hasCompletionItemLabel(expressionWrapperAliasList?.items, 'weighted_name'),
      'Expected ExpressionWrapper() aliases to propagate onto annotated instances.'
    );

    const subqueryAliasPosition = positionAfterTextInContainer(
      document,
      'Product.objects.annotate(matching_name=models.Subquery(Product.objects.filter(pk=models.OuterRef("name")).values("category__sl")[:1])).first().ma',
      'first().ma'
    );
    const subqueryAliasList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        subqueryAliasPosition
      );

    assert.ok(
      hasCompletionItemLabel(subqueryAliasList?.items, 'matching_name'),
      'Expected Subquery() aliases to propagate onto annotated instances.'
    );

    const existsAliasPosition = positionAfterTextInContainer(
      document,
      "Product.objects.annotate(has_active_category=models.Exists(Product.objects.filter(pk=models.OuterRef(\"pk\"), category__sl='chairs'))).first().ha",
      'first().ha'
    );
    const existsAliasList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        existsAliasPosition
      );

    assert.ok(
      hasCompletionItemLabel(existsAliasList?.items, 'has_active_category'),
      'Expected Exists() aliases to propagate onto annotated instances.'
    );
  });

  test('shows hover and definition for conditional and composed expression field paths', async function () {
    this.timeout(60_000);

    const fixtureRoot = path.resolve(
      __dirname,
      '../../fixtures/advanced_queries_project'
    );
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'sales/query_examples.py'
    );

    const whenHoverPosition = positionInsideText(
      document,
      "Product.objects.annotate(category_bucket=Case(When(category__slug='chairs', then=Value('chairs')), default=Value('other')))",
      'category__slug'
    );
    const whenHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      whenHoverPosition
    );
    const whenHoverText = stringifyHovers(whenHovers);

    assert.ok(
      whenHoverText.includes('Owner model: `catalog.Category`'),
      `Expected When() hover to mention catalog.Category. Received: ${whenHoverText}`
    );
    assert.ok(
      whenHoverText.includes('Field kind: `SlugField`'),
      `Expected When() hover to mention SlugField. Received: ${whenHoverText}`
    );

    const whenDefinitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, whenHoverPosition);
    const whenDefinitionTarget = firstDefinition(whenDefinitions);

    assert.ok(
      whenDefinitionTarget,
      'Expected When() conditions to resolve to the referenced model field.'
    );
    assert.ok(
      whenDefinitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'advanced_queries_project', 'catalog', 'models.py')
      ),
      `Expected When() definition to target catalog/models.py. Received: ${whenDefinitionTarget!.uri.fsPath}`
    );
    assert.strictEqual(
      whenDefinitionTarget!.range.start.line + 1,
      5,
      'Expected When() definition to target Category.slug.'
    );

    const whenConditionHoverPosition = positionInsideText(
      document,
      "Product.objects.annotate(category_bucket=Case(When(condition=models.Q(category__slug='chairs'), then=Value('chairs')), default=Value('other')))",
      'category__slug'
    );
    const whenConditionHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        whenConditionHoverPosition
      );
    const whenConditionHoverText = stringifyHovers(whenConditionHovers);

    assert.ok(
      whenConditionHoverText.includes('Owner model: `catalog.Category`'),
      `Expected When(condition=Q(...)) hover to mention catalog.Category. Received: ${whenConditionHoverText}`
    );
    assert.ok(
      whenConditionHoverText.includes('Field kind: `SlugField`'),
      `Expected When(condition=Q(...)) hover to mention SlugField. Received: ${whenConditionHoverText}`
    );

    const whenConditionDefinitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >(
      'vscode.executeDefinitionProvider',
      document.uri,
      whenConditionHoverPosition
    );
    const whenConditionDefinitionTarget = firstDefinition(
      whenConditionDefinitions
    );

    assert.ok(
      whenConditionDefinitionTarget,
      'Expected When(condition=Q(...)) definitions to resolve to the referenced model field.'
    );
    assert.ok(
      whenConditionDefinitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'advanced_queries_project', 'catalog', 'models.py')
      ),
      `Expected When(condition=Q(...)) definition to target catalog/models.py. Received: ${whenConditionDefinitionTarget!.uri.fsPath}`
    );
    assert.strictEqual(
      whenConditionDefinitionTarget!.range.start.line + 1,
      5,
      'Expected When(condition=Q(...)) definition to target Category.slug.'
    );

    const castHoverPosition = positionInsideText(
      document,
      'Product.objects.annotate(category_title_text=models.Cast("category__title", output_field=models.CharField()))',
      'category__title'
    );
    const castHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      castHoverPosition
    );
    const castHoverText = stringifyHovers(castHovers);

    assert.ok(
      castHoverText.includes('Owner model: `catalog.Category`'),
      `Expected Cast() hover to mention catalog.Category. Received: ${castHoverText}`
    );
    assert.ok(
      castHoverText.includes('Field kind: `CharField`'),
      `Expected Cast() hover to mention CharField. Received: ${castHoverText}`
    );

    const castDefinitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, castHoverPosition);
    const castDefinitionTarget = firstDefinition(castDefinitions);

    assert.ok(
      castDefinitionTarget,
      'Expected Cast() field paths to resolve to the referenced model field.'
    );
    assert.ok(
      castDefinitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'advanced_queries_project', 'catalog', 'models.py')
      ),
      `Expected Cast() definition to target catalog/models.py. Received: ${castDefinitionTarget!.uri.fsPath}`
    );
    assert.strictEqual(
      castDefinitionTarget!.range.start.line + 1,
      6,
      'Expected Cast() definition to target Category.title.'
    );
  });

  test('infers loop and comprehension target receivers from querysets and typed collections', async function () {
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

    const querysetLoopCompletionPosition = positionAfterTextInContainer(
      document,
      'loop_product.category.ti',
      'loop_product.category.ti'
    );
    const querysetLoopCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        querysetLoopCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(querysetLoopCompletionList?.items, 'title'),
      'Expected queryset loop targets to keep related model member completion.'
    );

    const typedCollectionCompletionPosition = positionAfterTextInContainer(
      document,
      'typed_product.category.ti',
      'typed_product.category.ti'
    );
    const typedCollectionCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        typedCollectionCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(typedCollectionCompletionList?.items, 'title'),
      'Expected typed collection loop targets to resolve as model instances.'
    );

    const typingSequenceLoopCompletionPosition = positionAfterTextInContainer(
      document,
      'sequence_product.category.ti',
      'sequence_product.category.ti'
    );
    const typingSequenceLoopCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        typingSequenceLoopCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(typingSequenceLoopCompletionList?.items, 'title'),
      'Expected `from typing import Sequence as ...` loop targets to resolve as model instances.'
    );

    const typingModuleLoopCompletionPosition = positionAfterTextInContainer(
      document,
      'typed_list_fd.de',
      'typed_list_fd.de'
    );
    const typingModuleLoopCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        typingModuleLoopCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(typingModuleLoopCompletionList?.items, 'detail_code'),
      'Expected `import typing as ...` list annotations to resolve loop targets as FulfillmentDetail.'
    );
    assert.ok(
      !hasCompletionItemLabel(typingModuleLoopCompletionList?.items, 'reference'),
      'Expected `import typing as ...` list annotations to avoid switching loop targets to Fulfillment.'
    );

    const typedQuerysetCompletionPosition = positionAfterTextInContainer(
      document,
      'typed_queryset.with_li',
      'typed_queryset.with_li'
    );
    const typedQuerysetCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        typedQuerysetCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(typedQuerysetCompletionList?.items, 'with_line_count'),
      'Expected typed queryset loop targets to resolve as queryset receivers.'
    );

    const typedQuerysetLookupPosition = positionAfterTextInContainer(
      document,
      'typed_queryset.values("category__ti")',
      'category__ti'
    );
    const typedQuerysetLookupList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        typedQuerysetLookupPosition
      );

    assert.ok(
      hasCompletionItemLabel(typedQuerysetLookupList?.items, 'title'),
      'Expected typed queryset loop targets to keep queryset lookup completion.'
    );

    const typedComprehensionElementPosition = positionAfterTextInContainer(
      document,
      '{fd.ca for fd in fulfillment_details if fd.ca}',
      '{fd.ca'
    );
    const typedComprehensionElementList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        typedComprehensionElementPosition
      );

    assert.ok(
      hasCompletionItemLabel(typedComprehensionElementList?.items, 'category'),
      'Expected typed list-comprehension element receivers to resolve as model instances.'
    );

    const typedComprehensionFilterPosition = positionAfterTextInContainer(
      document,
      '{fd.ca for fd in fulfillment_details if fd.ca}',
      'if fd.ca'
    );
    const typedComprehensionFilterList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        typedComprehensionFilterPosition
      );

    assert.ok(
      hasCompletionItemLabel(typedComprehensionFilterList?.items, 'category'),
      'Expected typed list-comprehension filter receivers to resolve as model instances.'
    );

    const querysetComprehensionPosition = positionAfterTextInContainer(
      document,
      '{fd.category.ti for fd in Product.objects.active() if fd.ca}',
      'fd.category.ti'
    );
    const querysetComprehensionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        querysetComprehensionPosition
      );

    assert.ok(
      hasCompletionItemLabel(querysetComprehensionList?.items, 'title'),
      'Expected queryset comprehension receivers to keep related model member completion.'
    );

    const typingModuleComprehensionFilterPosition = positionAfterTextInContainer(
      document,
      '{typed_fd.detail_code for typed_fd in fulfillment_details if typed_fd.de}',
      'if typed_fd.de'
    );
    const typingModuleComprehensionFilterList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        typingModuleComprehensionFilterPosition
      );

    assert.ok(
      hasCompletionItemLabel(typingModuleComprehensionFilterList?.items, 'detail_code'),
      'Expected `import typing as ...` list annotations to resolve comprehension receivers as FulfillmentDetail.'
    );

    const typingOptionalLoopCompletionPosition = positionAfterTextInContainer(
      document,
      'optional_fd.fulfillment.re',
      'optional_fd.fulfillment.re'
    );
    const typingOptionalLoopCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        typingOptionalLoopCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(typingOptionalLoopCompletionList?.items, 'reference'),
      'Expected `from typing import Optional, Iterable` loop targets to resolve related model members.'
    );
    assert.ok(
      !hasCompletionItemLabel(typingOptionalLoopCompletionList?.items, 'detail_code'),
      'Expected `from typing import Optional, Iterable` loop targets to avoid leaking source-model fields after following the relation.'
    );

    const typingUnionLoopCompletionPosition = positionAfterTextInContainer(
      document,
      'union_fd.fulfillment.re',
      'union_fd.fulfillment.re'
    );
    const typingUnionLoopCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        typingUnionLoopCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(typingUnionLoopCompletionList?.items, 'reference'),
      'Expected `from typing import Union as ...` loop targets to resolve related model members.'
    );
    assert.ok(
      !hasCompletionItemLabel(typingUnionLoopCompletionList?.items, 'detail_code'),
      'Expected `from typing import Union as ...` loop targets to avoid leaking source-model fields after following the relation.'
    );

    const wrappedComprehensionElementPosition = positionAfterTextInContainer(
      document,
      'return list({fd.ca for fd in fulfillment_details if fd.ca})',
      '{fd.ca'
    );
    const wrappedComprehensionElementList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        wrappedComprehensionElementPosition
      );

    assert.ok(
      hasCompletionItemLabel(wrappedComprehensionElementList?.items, 'category'),
      'Expected list-wrapped comprehension element receivers to resolve as model instances.'
    );

    const wrappedComprehensionFilterPosition = positionAfterTextInContainer(
      document,
      'return list({fd.ca for fd in fulfillment_details if fd.ca})',
      'if fd.ca'
    );
    const wrappedComprehensionFilterList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        wrappedComprehensionFilterPosition
      );

    assert.ok(
      hasCompletionItemLabel(wrappedComprehensionFilterList?.items, 'category'),
      'Expected list-wrapped comprehension filter receivers to resolve as model instances.'
    );

    const importedAliasWrappedComprehensionElementPosition =
      positionAfterTextInContainer(
        document,
        'return list({fd.fulfillment for fd in fulfillment_details if fd.fulfillment})',
        'fd.ful'
      );
    const importedAliasWrappedComprehensionElementList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        importedAliasWrappedComprehensionElementPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        importedAliasWrappedComprehensionElementList?.items,
        'fulfillment'
      ),
      'Expected exact List[FulfillmentDetail] comprehension element receivers to resolve as FulfillmentDetail instances.'
    );

    const importedAliasWrappedComprehensionFilterPosition =
      positionAfterTextInContainer(
        document,
        'return list({fd.fulfillment for fd in fulfillment_details if fd.fulfillment})',
        'if fd.ful'
      );
    const importedAliasWrappedComprehensionFilterList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        importedAliasWrappedComprehensionFilterPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        importedAliasWrappedComprehensionFilterList?.items,
        'fulfillment'
      ),
      'Expected exact List[FulfillmentDetail] comprehension filter receivers to resolve as FulfillmentDetail instances.'
    );

    const importedAliasWrappedComprehensionHoverPosition =
      positionInsideText(
        document,
        'return list({fd.fulfillment for fd in fulfillment_details if fd.fulfillment})',
        'if fd.fulfillment'
      );
    const importedAliasWrappedComprehensionHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        importedAliasWrappedComprehensionHoverPosition
      );
    const importedAliasWrappedComprehensionHoverText = stringifyHovers(
      importedAliasWrappedComprehensionHovers
    );

    assert.ok(
      importedAliasWrappedComprehensionHoverText.includes(
        'Receiver model: `sales.FulfillmentDetail`'
      ),
      `Expected if-clause comprehension member hover to keep the receiver as sales.FulfillmentDetail. Received: ${importedAliasWrappedComprehensionHoverText}`
    );
    assert.ok(
      importedAliasWrappedComprehensionHoverText.includes(
        'Return model: `sales.Fulfillment`'
      ),
      `Expected if-clause comprehension member hover to resolve the member return model as sales.Fulfillment. Received: ${importedAliasWrappedComprehensionHoverText}`
    );

    const methodWrappedComprehensionContainer = `class FulfillmentService:
    def extract_unique_fulfillments(self, fulfillment_details: List[FulfillmentDetail]) -> List[Fulfillment]:
        return list({fd.fulfillment for fd in fulfillment_details if fd.fulfillment})`;

    const methodWrappedComprehensionReceiverPosition =
      positionAfterTextInContainer(
        document,
        methodWrappedComprehensionContainer,
        'if fd.'
      );
    const methodWrappedComprehensionReceiverList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        methodWrappedComprehensionReceiverPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        methodWrappedComprehensionReceiverList?.items,
        'fulfillment'
      ),
      'Expected exact class-method if-clause receiver completion to include FulfillmentDetail fields.'
    );
    assert.ok(
      !hasCompletionItemLabel(
        methodWrappedComprehensionReceiverList?.items,
        'reference'
      ),
      'Expected exact class-method if-clause receiver completion to avoid switching the receiver to Fulfillment.'
    );
    assert.ok(
      hasCompletionItemLabel(
        methodWrappedComprehensionReceiverList?.items,
        'detail_code'
      ),
      'Expected exact user-code completion at `if fd.` to keep `fd` typed as FulfillmentDetail and expose FulfillmentDetail-only fields.'
    );

    const methodWrappedComprehensionHoverPosition =
      positionInsideText(
        document,
        methodWrappedComprehensionContainer,
        'if fd.fulfillment'
      );
    const methodWrappedComprehensionHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        methodWrappedComprehensionHoverPosition
      );
    const methodWrappedComprehensionHoverText = stringifyHovers(
      methodWrappedComprehensionHovers
    );

    assert.ok(
      methodWrappedComprehensionHoverText.includes(
        'Receiver model: `sales.FulfillmentDetail`'
      ),
      `Expected exact class-method if-clause member hover to keep the receiver as sales.FulfillmentDetail. Received: ${methodWrappedComprehensionHoverText}`
    );
    assert.ok(
      methodWrappedComprehensionHoverText.includes(
        'Return model: `sales.Fulfillment`'
      ),
      `Expected exact class-method if-clause member hover to keep the return model as sales.Fulfillment. Received: ${methodWrappedComprehensionHoverText}`
    );

    const exactRepeatedAccessContainer =
      'return list({fdd.fulfillment for fdd in fulfillment_details if fdd.fulfillment})';
    const exactRepeatedReceiverDotPosition = positionAfterTextInContainer(
      document,
      exactRepeatedAccessContainer,
      'if fdd.'
    );
    const exactRepeatedReceiverDotList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        exactRepeatedReceiverDotPosition
      );

    assert.ok(
      hasCompletionItemLabel(exactRepeatedReceiverDotList?.items, 'detail_code'),
      'Expected the repeated `if fdd.` completion to expose FulfillmentDetail-only fields.'
    );
    assert.ok(
      !hasCompletionItemLabel(exactRepeatedReceiverDotList?.items, 'reference'),
      'Expected the repeated `if fdd.` completion to avoid switching the receiver to Fulfillment.'
    );

    const methodReceiverProbeContainer =
      'return list({fd.fulfillment for fd in fulfillment_details if fd.de})';
    const methodReceiverProbePosition = positionAfterTextInContainer(
      document,
      methodReceiverProbeContainer,
      'if fd.de'
    );
    const methodReceiverProbeList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        methodReceiverProbePosition
      );
    const detailCodeCompletionItem = findCompletionItemByLabel(
      methodReceiverProbeList?.items,
      'detail_code'
    );

    assert.ok(
      detailCodeCompletionItem,
      'Expected partial completion inside the class-method if-clause to keep `fd` typed as FulfillmentDetail.'
    );
    assert.strictEqual(
      completionItemLabelDetail(detailCodeCompletionItem!),
      ' (CharField)',
      'Expected the `if fd.de` completion probe to expose the FulfillmentDetail field kind inline in the suggestion list.'
    );
    assert.strictEqual(
      completionItemDescription(detailCodeCompletionItem!),
      'FulfillmentDetail',
      'Expected the `if fd.de` completion probe to expose the inferred receiver model inline in the suggestion list.'
    );
    assert.ok(
      !hasCompletionItemLabel(methodReceiverProbeList?.items, 'reference'),
      'Expected the `if fd.de` completion probe to reject Fulfillment fields while resolving `fd`.'
    );

    const methodRelationProbeContainer =
      'return list({fd.fulfillment.reference for fd in fulfillment_details if fd.fulfillment.re})';
    const methodRelationProbePosition = positionAfterTextInContainer(
      document,
      methodRelationProbeContainer,
      'if fd.fulfillment.re'
    );
    const methodRelationProbeList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        methodRelationProbePosition
      );
    const referenceCompletionItem = findCompletionItemByLabel(
      methodRelationProbeList?.items,
      'reference'
    );

    assert.ok(
      referenceCompletionItem,
      'Expected partial completion after `if fd.fulfillment.` to switch to the Fulfillment receiver.'
    );
    assert.strictEqual(
      completionItemLabelDetail(referenceCompletionItem!),
      ' (CharField)',
      'Expected the `if fd.fulfillment.re` completion probe to expose Fulfillment field kinds inline in the suggestion list.'
    );
    assert.strictEqual(
      completionItemDescription(referenceCompletionItem!),
      'Fulfillment',
      'Expected the `if fd.fulfillment.re` completion probe to expose the inferred receiver model inline in the suggestion list.'
    );
    assert.ok(
      !hasCompletionItemLabel(methodRelationProbeList?.items, 'detail_code'),
      'Expected the `if fd.fulfillment.re` completion probe to avoid leaking FulfillmentDetail fields after following the relation.'
    );
  });

  test('shows hover and definition for custom queryset methods', async function () {
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

    const activeHoverPosition = positionInsideText(
      document,
      'Product.objects.active().with_line_count()',
      'active'
    );
    const activeHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      activeHoverPosition
    );
    const activeHoverText = stringifyHovers(activeHovers);

    assert.ok(
      activeHoverText.includes('Receiver kind: `manager`'),
      `Expected custom method hover to mention the manager receiver. Received: ${activeHoverText}`
    );
    assert.ok(
      activeHoverText.includes('Return kind: `queryset`'),
      `Expected custom method hover to mention queryset return semantics. Received: ${activeHoverText}`
    );
    assert.ok(
      activeHoverText.includes('Source: `runtime`') ||
        activeHoverText.includes('Source: `static`'),
      `Expected custom method hover to mention traced member discovery. Received: ${activeHoverText}`
    );

    const activeDefinitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, activeHoverPosition);
    const activeDefinitionTarget = firstDefinition(activeDefinitions);

    assert.ok(
      activeDefinitionTarget,
      'Expected a definition target for the custom `active` queryset method.'
    );
    assert.ok(
      activeDefinitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'advanced_queries_project', 'sales', 'managers.py')
      ),
      `Expected custom method definition to target sales/managers.py. Received: ${activeDefinitionTarget!.uri.fsPath}`
    );
    assert.strictEqual(
      activeDefinitionTarget!.range.start.line + 1,
      5,
      'Expected `active` definition to target ProductQuerySet.active.'
    );

    const withLineCountHoverPosition = positionInsideText(
      document,
      'Product.objects.active().with_line_count()',
      'with_line_count'
    );
    const withLineCountDefinitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, withLineCountHoverPosition);
    const withLineCountDefinitionTarget = firstDefinition(withLineCountDefinitions);

    assert.ok(
      withLineCountDefinitionTarget,
      'Expected a definition target for the custom `with_line_count` queryset method.'
    );
    assert.strictEqual(
      withLineCountDefinitionTarget!.range.start.line + 1,
      8,
      'Expected `with_line_count` definition to target ProductQuerySet.with_line_count.'
    );
  });

  test('shows hover for manager and queryset classes at imports, references, and definitions', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(
      __dirname,
      '../../fixtures/advanced_queries_project'
    );
    await setWorkspaceRoot(fixtureRoot);

    const modelsDocument = await openFixtureDocument(
      fixtureRoot,
      'sales/models.py'
    );
    const managerImportHoverPosition = positionInsideText(
      modelsDocument,
      'objects = ProductManager()',
      'ProductManager'
    );
    const managerImportHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      modelsDocument.uri,
      managerImportHoverPosition
    );
    const managerImportHoverText = stringifyHovers(managerImportHovers);

    assert.ok(
      managerImportHoverText.includes('Resolved symbol: `sales.managers.ProductManager`'),
      `Expected imported manager hover to resolve ProductManager. Received: ${managerImportHoverText}`
    );
    assert.ok(
      managerImportHoverText.includes('File: `sales/managers.py`'),
      `Expected imported manager hover to mention sales/managers.py. Received: ${managerImportHoverText}`
    );

    const managersDocument = await openFixtureDocument(
      fixtureRoot,
      'sales/managers.py'
    );

    const querysetReferenceHoverPosition = positionInsideText(
      managersDocument,
      'class ProductManager(models.Manager.from_queryset(ProductQuerySet)):',
      'ProductQuerySet'
    );
    const querysetReferenceHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        managersDocument.uri,
        querysetReferenceHoverPosition
      );
    const querysetReferenceHoverText = stringifyHovers(querysetReferenceHovers);

    assert.ok(
      querysetReferenceHoverText.includes(
        'Resolved symbol: `sales.managers.ProductQuerySet`'
      ),
      `Expected local queryset class reference hover to resolve ProductQuerySet. Received: ${querysetReferenceHoverText}`
    );
    assert.ok(
      querysetReferenceHoverText.includes('Class kind: `queryset`'),
      `Expected local queryset class reference hover to mention queryset kind. Received: ${querysetReferenceHoverText}`
    );

    const querysetDefinitionHoverPosition = positionInsideText(
      managersDocument,
      'class ProductQuerySet(models.QuerySet):',
      'ProductQuerySet'
    );
    const querysetDefinitionHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        managersDocument.uri,
        querysetDefinitionHoverPosition
      );
    const querysetDefinitionHoverText = stringifyHovers(
      querysetDefinitionHovers
    );

    assert.ok(
      querysetDefinitionHoverText.includes(
        'Resolved symbol: `sales.managers.ProductQuerySet`'
      ),
      `Expected queryset class definition hover to resolve ProductQuerySet. Received: ${querysetDefinitionHoverText}`
    );
    assert.ok(
      querysetDefinitionHoverText.includes(
        'Resolved from class definition `ProductQuerySet`.'
      ),
      `Expected queryset class definition hover to mention the class definition context. Received: ${querysetDefinitionHoverText}`
    );

    const managerDefinitionHoverPosition = positionInsideText(
      managersDocument,
      'class ProductManager(models.Manager.from_queryset(ProductQuerySet)):',
      'ProductManager'
    );
    const managerDefinitionHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        managersDocument.uri,
        managerDefinitionHoverPosition
      );
    const managerDefinitionHoverText = stringifyHovers(managerDefinitionHovers);

    assert.ok(
      managerDefinitionHoverText.includes(
        'Resolved symbol: `sales.managers.ProductManager`'
      ),
      `Expected manager class definition hover to resolve ProductManager. Received: ${managerDefinitionHoverText}`
    );
    assert.ok(
      managerDefinitionHoverText.includes('Class kind: `manager`'),
      `Expected manager class definition hover to mention manager kind. Received: ${managerDefinitionHoverText}`
    );
    assert.ok(
      managerDefinitionHoverText.includes(
        'Resolved from class definition `ProductManager`.'
      ),
      `Expected manager class definition hover to mention the class definition context. Received: ${managerDefinitionHoverText}`
    );
  });

  test('shows hover for classes and types inside type hints', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(
      __dirname,
      '../../fixtures/advanced_queries_project'
    );
    await setWorkspaceRoot(fixtureRoot);

    const queryExamplesDocument = await openFixtureDocument(
      fixtureRoot,
      'sales/query_examples.py'
    );

    const productTypeHintHoverPosition = positionInsideText(
      queryExamplesDocument,
      'def loop_examples(products: list[Product], queryset_groups: list[QuerySet[Product]]):',
      'Product'
    );
    const productTypeHintHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        queryExamplesDocument.uri,
        productTypeHintHoverPosition
      );
    const productTypeHintHoverText = stringifyHovers(productTypeHintHovers);

    assert.ok(
      productTypeHintHoverText.includes('sales.models.Product'),
      `Expected type-hint hover on Product to resolve sales.models.Product. Received: ${productTypeHintHoverText}`
    );
    assert.ok(
      productTypeHintHoverText.includes('Class category: `django`'),
      `Expected type-hint hover on Product to mark the class as django. Received: ${productTypeHintHoverText}`
    );

    const typingAliasHoverPosition = positionInsideText(
      queryExamplesDocument,
      'optional_fulfillment_details: TypingOptional[TypingIterable[FulfillmentDetail]]',
      'TypingOptional'
    );
    const typingAliasHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        queryExamplesDocument.uri,
        typingAliasHoverPosition
      );
    const typingAliasHoverText = stringifyHovers(typingAliasHovers);

    assert.ok(
      typingAliasHoverText.includes('typing.Optional'),
      `Expected type-hint hover on TypingOptional to mention typing.Optional. Received: ${typingAliasHoverText}`
    );

    const returnTypeHoverPosition = positionInsideText(
      queryExamplesDocument,
      '-> List[Fulfillment]:',
      'List'
    );
    const returnTypeHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        queryExamplesDocument.uri,
        returnTypeHoverPosition
      );
    const returnTypeHoverText = stringifyHovers(returnTypeHovers);

    assert.ok(
      returnTypeHoverText.includes('typing.List'),
      `Expected return type-hint hover on List to mention typing.List. Received: ${returnTypeHoverText}`
    );

    const managersDocument = await openFixtureDocument(
      fixtureRoot,
      'sales/managers.py'
    );
    const forwardReferenceHoverPosition = positionInsideText(
      managersDocument,
      "def active(self) -> 'ProductQuerySet':",
      'ProductQuerySet'
    );
    const forwardReferenceHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        managersDocument.uri,
        forwardReferenceHoverPosition
      );
    const forwardReferenceHoverText = stringifyHovers(forwardReferenceHovers);

    assert.ok(
      forwardReferenceHoverText.includes(
        'sales.managers.ProductQuerySet'
      ),
      `Expected forward-reference type-hint hover to resolve ProductQuerySet. Received: ${forwardReferenceHoverText}`
    );
    assert.ok(
      forwardReferenceHoverText.includes(
        'Resolved from type hint `ProductQuerySet`.'
      ),
      `Expected forward-reference type-hint hover to mention the type-hint context. Received: ${forwardReferenceHoverText}`
    );
  });

  test('distinguishes general classes from django classes in hover info', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(
      __dirname,
      '../../fixtures/advanced_queries_project'
    );
    await setWorkspaceRoot(fixtureRoot);

    const queryExamplesDocument = await openFixtureDocument(
      fixtureRoot,
      'sales/query_examples.py'
    );

    const generalImportHoverPosition = positionInsideText(
      queryExamplesDocument,
      'return ProductLookupService.available_products()',
      'ProductLookupService'
    );
    const generalImportHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        queryExamplesDocument.uri,
        generalImportHoverPosition
      );
    const generalImportHoverText = stringifyHovers(generalImportHovers);

    assert.ok(
      generalImportHoverText.includes(
        'Resolved symbol: `sales.services.ProductLookupService`'
      ),
      `Expected imported general class hover to resolve ProductLookupService. Received: ${generalImportHoverText}`
    );
    assert.ok(
      generalImportHoverText.includes('Defined in `sales.services`'),
      `Expected imported general class hover to mention the defining module. Received: ${generalImportHoverText}`
    );
    assert.ok(
      generalImportHoverText.includes('File: `sales/services.py`'),
      `Expected imported general class hover to mention the defining file. Received: ${generalImportHoverText}`
    );
    assert.ok(
      generalImportHoverText.includes('Class category: `general`'),
      `Expected imported general class hover to mark ProductLookupService as general. Received: ${generalImportHoverText}`
    );

    const djangoImportHoverPosition = positionInsideText(
      queryExamplesDocument,
      'active_products = Product.objects.active()',
      'Product'
    );
    const djangoImportHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        queryExamplesDocument.uri,
        djangoImportHoverPosition
      );
    const djangoImportHoverText = stringifyHovers(djangoImportHovers);

    assert.ok(
      djangoImportHoverText.includes('Resolved symbol: `sales.models.Product`'),
      `Expected imported django class hover to resolve Product. Received: ${djangoImportHoverText}`
    );
    assert.ok(
      djangoImportHoverText.includes('Class category: `django`'),
      `Expected imported django class hover to mark Product as django. Received: ${djangoImportHoverText}`
    );

    const typedManagerHoverPosition = positionInsideText(
      queryExamplesDocument,
      "typed_generic_catalog_manager.create(na='draft')",
      'typed_generic_catalog_manager'
    );
    const typedManagerHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        queryExamplesDocument.uri,
        typedManagerHoverPosition
      );
    const typedManagerHoverText = stringifyHovers(typedManagerHovers);

    assert.ok(
      typedManagerHoverText.includes(
        '**typed_generic_catalog_manager**: `CatalogManager` manager'
      ),
      `Expected typed generic manager hover to resolve the custom manager receiver. Received: ${typedManagerHoverText}`
    );
    assert.ok(
      typedManagerHoverText.includes('Model: `sales.Product`'),
      `Expected typed generic manager hover to mention the managed model. Received: ${typedManagerHoverText}`
    );
    assert.ok(
      typedManagerHoverText.includes(
        'Resolved symbol: `sales.managers.CatalogManager`'
      ),
      `Expected typed generic manager hover to mention the manager class symbol. Received: ${typedManagerHoverText}`
    );
    assert.ok(
      typedManagerHoverText.includes('Class kind: `manager`'),
      `Expected typed generic manager hover to mark the receiver as a manager class. Received: ${typedManagerHoverText}`
    );

    const servicesDocument = await openFixtureDocument(
      fixtureRoot,
      'sales/services.py'
    );
    const generalDefinitionHoverPosition = positionInsideText(
      servicesDocument,
      'class ProductLookupService(BaseProductService):',
      'ProductLookupService'
    );
    const generalDefinitionHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        servicesDocument.uri,
        generalDefinitionHoverPosition
      );
    const generalDefinitionHoverText = stringifyHovers(generalDefinitionHovers);

    assert.ok(
      generalDefinitionHoverText.includes('Class category: `general`'),
      `Expected ProductLookupService definition hover to mark the class as general. Received: ${generalDefinitionHoverText}`
    );

    const modelsDocument = await openFixtureDocument(
      fixtureRoot,
      'sales/models.py'
    );
    const djangoDefinitionHoverPosition = positionInsideText(
      modelsDocument,
      'class Product(models.Model):',
      'Product'
    );
    const djangoDefinitionHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        modelsDocument.uri,
        djangoDefinitionHoverPosition
      );
    const djangoDefinitionHoverText = stringifyHovers(djangoDefinitionHovers);

    assert.ok(
      djangoDefinitionHoverText.includes('Class category: `django`'),
      `Expected Product definition hover to mark the class as django. Received: ${djangoDefinitionHoverText}`
    );
  });

  test('shows hover for Django builtin instance and queryset methods', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    // --- Instance builtin method: save() ---
    const saveHoverPosition = positionInsideText(
      document,
      'post.save()',
      'save'
    );
    const saveHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      saveHoverPosition
    );
    const saveHoverText = stringifyHovers(saveHovers);

    assert.ok(
      saveHoverText.includes('save'),
      `Expected builtin instance method hover to mention save. Received: ${saveHoverText}`
    );
    assert.ok(
      saveHoverText.includes('Receiver kind: `instance`'),
      `Expected builtin instance method hover to show instance receiver. Received: ${saveHoverText}`
    );

    // --- Instance builtin method: full_clean() ---
    const fullCleanHoverPosition = positionInsideText(
      document,
      'post.full_clean()',
      'full_clean'
    );
    const fullCleanHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        fullCleanHoverPosition
      );
    const fullCleanHoverText = stringifyHovers(fullCleanHovers);

    assert.ok(
      fullCleanHoverText.includes('full_clean'),
      `Expected full_clean hover to show method name. Received: ${fullCleanHoverText}`
    );
    assert.ok(
      fullCleanHoverText.includes('Receiver kind: `instance`'),
      `Expected full_clean hover to show instance receiver. Received: ${fullCleanHoverText}`
    );

    // --- Instance builtin method: refresh_from_db() ---
    const refreshHoverPosition = positionInsideText(
      document,
      'post.refresh_from_db()',
      'refresh_from_db'
    );
    const refreshHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      refreshHoverPosition
    );
    const refreshHoverText = stringifyHovers(refreshHovers);

    assert.ok(
      refreshHoverText.includes('refresh_from_db'),
      `Expected refresh_from_db hover to show method name. Received: ${refreshHoverText}`
    );
    assert.ok(
      refreshHoverText.includes('Receiver kind: `instance`'),
      `Expected refresh_from_db hover to show instance receiver. Received: ${refreshHoverText}`
    );

    // --- QuerySet builtin method: union() ---
    const unionHoverPosition = positionInsideText(
      document,
      'qs.union(Post.objects.none())',
      'union'
    );
    const unionHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      unionHoverPosition
    );
    const unionHoverText = stringifyHovers(unionHovers);

    assert.ok(
      unionHoverText.includes('union'),
      `Expected queryset builtin union hover to show method name. Received: ${unionHoverText}`
    );
    assert.ok(
      unionHoverText.includes('Return kind: `queryset`'),
      `Expected queryset builtin union hover to show queryset return. Received: ${unionHoverText}`
    );
    assert.ok(
      unionHoverText.includes('Receiver kind: `queryset`'),
      `Expected queryset builtin union hover to show queryset receiver. Received: ${unionHoverText}`
    );

    // --- QuerySet builtin method: explain() ---
    const explainHoverPosition = positionInsideText(
      document,
      'qs.explain()',
      'explain'
    );
    const explainHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      explainHoverPosition
    );
    const explainHoverText = stringifyHovers(explainHovers);

    assert.ok(
      explainHoverText.includes('explain'),
      `Expected queryset builtin explain hover to show method name. Received: ${explainHoverText}`
    );
    assert.ok(
      explainHoverText.includes('Receiver kind: `queryset`'),
      `Expected queryset builtin explain hover to show queryset receiver. Received: ${explainHoverText}`
    );

    // --- Completion: instance builtins appear ---
    const instanceCompletionPosition = positionAfterText(
      document,
      'post.save'
    );
    const instanceCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        instanceCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(instanceCompletionList?.items ?? [], 'save'),
      'Expected instance builtin completion to include save.'
    );
    assert.ok(
      hasCompletionItemLabel(
        instanceCompletionList?.items ?? [],
        'full_clean'
      ),
      'Expected instance builtin completion to include full_clean.'
    );
    assert.ok(
      hasCompletionItemLabel(
        instanceCompletionList?.items ?? [],
        'refresh_from_db'
      ),
      'Expected instance builtin completion to include refresh_from_db.'
    );
    assert.ok(
      hasCompletionItemLabel(instanceCompletionList?.items ?? [], 'delete'),
      'Expected instance builtin completion to include delete.'
    );

    // --- Completion: queryset builtins appear ---
    const qsCompletionPosition = positionAfterText(
      document,
      'qs.select_for_update'
    );
    const qsCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        qsCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        qsCompletionList?.items ?? [],
        'select_for_update'
      ),
      'Expected queryset builtin completion to include select_for_update.'
    );
  });

  test('resolves lookup paths inside deeply nested multiline Q/When/Case expressions', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    // --- Q() keyword inside When() inside Case() inside annotate() ---
    const nestedQHoverPosition = positionInsideText(
      document,
      'Q(question_thread_set__is_open=True)',
      'question_thread_set__is_open'
    );
    const nestedQHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        nestedQHoverPosition
      );
    const nestedQHoverText = stringifyHovers(nestedQHovers);

    assert.ok(
      nestedQHoverText.includes('Owner model:') ||
        nestedQHoverText.includes('Field kind:'),
      `Expected nested Q() lookup hover to resolve the field path. Received: ${nestedQHoverText}`
    );

    // --- Bare keyword inside When() inside Case() inside annotate() ---
    const bareWhenHoverPosition = positionInsideText(
      document,
      'question_thread_set__title="test"',
      'question_thread_set__title'
    );
    const bareWhenHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        bareWhenHoverPosition
      );
    const bareWhenHoverText = stringifyHovers(bareWhenHovers);

    assert.ok(
      bareWhenHoverText.includes('Owner model:') ||
        bareWhenHoverText.includes('Field kind:'),
      `Expected bare When() keyword lookup hover to resolve the field path. Received: ${bareWhenHoverText}`
    );

    // --- Multi-line Q() with | combinator inside filter() ---
    const filterQHoverPosition = positionInsideText(
      document,
      'Q(question_thread_set__title__icontains="test")',
      'question_thread_set__title__icontains'
    );
    const filterQHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        filterQHoverPosition
      );
    const filterQHoverText = stringifyHovers(filterQHovers);

    assert.ok(
      filterQHoverText.includes('Owner model:') ||
        filterQHoverText.includes('Field kind:'),
      `Expected multi-line filter Q() lookup hover to resolve the field path. Received: ${filterQHoverText}`
    );

    // --- Bare keyword in multi-line filter() ---
    const filterBareHoverPosition = positionInsideText(
      document,
      'name__icontains="corp"',
      'name__icontains'
    );
    const filterBareHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        filterBareHoverPosition
      );
    const filterBareHoverText = stringifyHovers(filterBareHovers);

    assert.ok(
      filterBareHoverText.includes('Owner model:') ||
        filterBareHoverText.includes('Field kind:'),
      `Expected multi-line filter bare keyword hover to resolve the field path. Received: ${filterBareHoverText}`
    );

    // --- Completion inside nested Q() ---
    const nestedQCompletionPosition = positionAfterText(
      document,
      'Q(question_thread_set__is_open'
    );
    const nestedQCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        nestedQCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        nestedQCompletionList?.items ?? [],
        'is_open'
      ),
      `Expected nested Q() completion to include is_open. Got: ${(nestedQCompletionList?.items ?? []).map(completionItemLabel).join(', ')}`
    );
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
    assert.ok(diagnostics.length > 0, 'Expected diagnostics to be non-empty before checking absence of valid paths');
    assert.ok(
      diagnostics.every((item) => !item.message.includes('`pk`')),
      `Expected pk lookup aliases to avoid diagnostics. Received: ${stringifyDiagnostics(diagnostics)}`
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

  test('shows hover and definition for imported class usages', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/reexport_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'library/import_examples.py'
    );

    const hoverPosition = positionInsideText(
      document,
      "Book.objects.filter(ti='x')",
      'Book'
    );
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      hoverPosition
    );
    const hoverText = stringifyHovers(hovers);

    assert.ok(
      hoverText.includes('defined in `library.models`'),
      `Expected imported class usage hover to describe the origin module. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('Resolved symbol: `library.models.Book`'),
      `Expected imported class usage hover to describe the resolved symbol. Received: ${hoverText}`
    );

    const definitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, hoverPosition);
    const definitionTarget = firstDefinition(definitions);

    assert.ok(
      definitionTarget,
      'Expected a definition target for the imported class usage.'
    );
    assert.ok(
      definitionTarget!.uri.fsPath.endsWith(
        path.join('fixtures', 'reexport_project', 'library', 'models.py')
      ),
      `Expected imported class usage definition to target library/models.py. Received: ${definitionTarget!.uri.fsPath}`
    );
    assert.strictEqual(definitionTarget!.range.start.line + 1, 4);
  });

  test('shows hover and definition for relative symbol imports', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/reexport_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'library/import_examples.py'
    );

    const hoverPosition = positionInsideText(
      document,
      'Book as DirectBook',
      'DirectBook'
    );
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      hoverPosition
    );
    const hoverText = stringifyHovers(hovers);

    assert.ok(
      hoverText.includes('Resolved symbol: `library.models.Book`'),
      `Expected relative import hover to describe the resolved symbol. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('File: `library/models.py`'),
      `Expected relative import hover to describe the resolved file. Received: ${hoverText}`
    );

    const definitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, hoverPosition);
    const definitionTarget = firstDefinition(definitions);

    assert.ok(
      definitionTarget,
      'Expected a definition target for the relative imported symbol.'
    );
    assert.strictEqual(
      definitionTarget!.range.start.line + 1,
      4,
      'Expected relative import definition to target the Book model.'
    );
  });

  test('shows hover and definition for multiline relative symbol imports', async function () {
    this.timeout(60_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/reexport_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'library/import_examples.py'
    );

    const hoverPosition = positionInsideText(
      document,
      'Book as MultiLineBook',
      'MultiLineBook'
    );
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      hoverPosition
    );
    const hoverText = stringifyHovers(hovers);

    assert.ok(
      hoverText.includes('Resolved symbol: `library.models.Book`'),
      `Expected multiline relative import hover to describe the resolved symbol. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('File: `library/models.py`'),
      `Expected multiline relative import hover to describe the resolved file. Received: ${hoverText}`
    );

    const definitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, hoverPosition);
    const definitionTarget = firstDefinition(definitions);

    assert.ok(
      definitionTarget,
      'Expected a definition target for the multiline relative imported symbol.'
    );
    assert.strictEqual(
      definitionTarget!.range.start.line + 1,
      4,
      'Expected multiline relative import definition to target the Book model.'
    );
  });

  test('shows hover and definition for module imports', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/reexport_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'library/import_examples.py'
    );

    const hoverPosition = positionInsideText(
      document,
      'import library.models as library_models',
      'library_models'
    );
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      hoverPosition
    );
    const hoverText = stringifyHovers(hovers);

    assert.ok(
      hoverText.includes('Module: `library.models`'),
      `Expected module import hover to describe the module name. Received: ${hoverText}`
    );
    assert.ok(
      hoverText.includes('File: `library/models.py`'),
      `Expected module import hover to describe the module file. Received: ${hoverText}`
    );

    const definitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >('vscode.executeDefinitionProvider', document.uri, hoverPosition);
    const definitionTarget = firstDefinition(definitions);

    assert.ok(
      definitionTarget,
      'Expected a definition target for the imported module.'
    );
    assert.strictEqual(
      definitionTarget!.range.start.line + 1,
      1,
      'Expected module import definition to target the module file.'
    );
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
      hasCompletionItemLabel(completionList?.items, 'title'),
      'Expected re-exported model keyword lookup completion to include `title`.'
    );
  });

  test('infers base models from multiline relative imports', async function () {
    this.timeout(60_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/reexport_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'library/import_examples.py'
    );

    const completionPosition = positionAfterTextInContainer(
      document,
      "MultiLineBook.objects.filter(ti='x')",
      'ti'
    );
    const completionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        completionPosition
      );

    assert.ok(
      hasCompletionItemLabel(completionList?.items, 'title'),
      'Expected multiline imported model keyword lookup completion to include `title`.'
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

  test('preserves explicit interpreter executable paths without collapsing symlinks', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'django-orm-intellisense-interpreter-symlink-')
    );

    try {
      const baseInterpreter = path.join(tempRoot, 'base', 'python3.11');
      const selectedInterpreter = path.join(tempRoot, 'venv', 'bin', 'python');

      fs.mkdirSync(path.dirname(baseInterpreter), { recursive: true });
      fs.mkdirSync(path.dirname(selectedInterpreter), { recursive: true });
      fs.writeFileSync(baseInterpreter, '#!/usr/bin/env python3\n');
      fs.chmodSync(baseInterpreter, 0o755);
      fs.symlinkSync(baseInterpreter, selectedInterpreter);

      const interpreter = await resolvePythonInterpreter({
        pythonInterpreter: selectedInterpreter,
        workspaceRoot: tempRoot,
        settingsModule: undefined,
        logLevel: 'off',
        autoStart: false,
      });

      assert.strictEqual(interpreter.path, selectedInterpreter);

      const validation = validatePythonInterpreterPath(selectedInterpreter);
      assert.ok(validation.valid, 'Expected the selected symlink interpreter to remain valid.');
      assert.strictEqual(validation.normalizedPath, selectedInterpreter);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('stores the exact interpreter path selected from browse', async function () {
    this.timeout(20_000);

    const tempWorkspace = fs.mkdtempSync(
      path.join(os.tmpdir(), 'django-orm-intellisense-interpreter-store-')
    );

    await removeWorkspaceFoldersFrom(0);
    await addWorkspaceFolder(tempWorkspace);

    try {
      const selectedInterpreter = path.join(tempWorkspace, 'venv', 'bin', 'python');
      fs.mkdirSync(path.dirname(selectedInterpreter), { recursive: true });
      fs.writeFileSync(selectedInterpreter, '#!/usr/bin/env python3\n');

      if (process.platform !== 'win32') {
        fs.chmodSync(selectedInterpreter, 0o755);
      }

      const storedValue = await savePythonInterpreterSetting(selectedInterpreter, {
        workspaceRoot: tempWorkspace,
        settingsModule: undefined,
        logLevel: 'off',
        autoStart: false,
      });

      assert.strictEqual(storedValue, selectedInterpreter);
      assert.strictEqual(
        vscode.workspace
          .getConfiguration('djangoOrmIntellisense', vscode.Uri.file(tempWorkspace))
          .get<string>('pythonInterpreter'),
        selectedInterpreter
      );
    } finally {
      await removeWorkspaceFoldersFrom(0);
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  test('prefers the workspace virtualenv path when the picker resolves a symlinked interpreter target', async function () {
    this.timeout(20_000);

    const tempWorkspace = fs.mkdtempSync(
      path.join(os.tmpdir(), 'django-orm-intellisense-interpreter-venv-link-')
    );

    await removeWorkspaceFoldersFrom(0);
    await addWorkspaceFolder(tempWorkspace);

    try {
      const externalInterpreter = path.join(
        tempWorkspace,
        'pyenv',
        'versions',
        '3.11.2',
        'bin',
        'python3.11'
      );
      const virtualEnvRoot = path.join(tempWorkspace, 'venv');
      const binDirectory = path.join(virtualEnvRoot, 'bin');
      const virtualEnvInterpreter = path.join(binDirectory, 'python3.11');
      const virtualEnvPython = path.join(binDirectory, 'python');

      fs.mkdirSync(path.dirname(externalInterpreter), { recursive: true });
      fs.mkdirSync(binDirectory, { recursive: true });
      fs.writeFileSync(externalInterpreter, '#!/usr/bin/env python3\n');
      fs.writeFileSync(
        path.join(virtualEnvRoot, 'pyvenv.cfg'),
        `home = ${path.dirname(externalInterpreter)}\n`,
        'utf8'
      );

      if (process.platform !== 'win32') {
        fs.chmodSync(externalInterpreter, 0o755);
      }

      fs.symlinkSync(externalInterpreter, virtualEnvPython);
      fs.symlinkSync('python', virtualEnvInterpreter);

      const storedValue = await savePythonInterpreterSetting(externalInterpreter, {
        workspaceRoot: tempWorkspace,
        settingsModule: undefined,
        logLevel: 'off',
        autoStart: false,
      });

      assert.strictEqual(storedValue, virtualEnvInterpreter);
      assert.strictEqual(
        vscode.workspace
          .getConfiguration('djangoOrmIntellisense', vscode.Uri.file(tempWorkspace))
          .get<string>('pythonInterpreter'),
        virtualEnvInterpreter
      );
    } finally {
      await removeWorkspaceFoldersFrom(0);
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  test('normalizes macOS /usr/bin/python3 to a usable developer tools interpreter', () => {
    if (process.platform !== 'darwin') {
      return;
    }

    const developerPython = [
      '/Applications/Xcode.app/Contents/Developer/usr/bin/python3',
      '/Library/Developer/CommandLineTools/usr/bin/python3',
    ].find((candidate) => fs.existsSync(candidate));

    if (!developerPython) {
      return;
    }

    const validation = validatePythonInterpreterPath('/usr/bin/python3');
    assert.ok(validation.valid, 'Expected /usr/bin/python3 normalization to remain valid.');
    assert.strictEqual(validation.normalizedPath, developerPython);
  });

  test('falls back only when pythonInterpreter is unset', async () => {
    const interpreter = await resolvePythonInterpreter({
      settingsModule: undefined,
      workspaceRoot: undefined,
      logLevel: 'off',
      autoStart: false,
    });

    assert.strictEqual(interpreter.source, 'fallback');
    assert.ok(interpreter.path.length > 0);
  });

  test('resolves legacy pythonPath settings before migration completes', async function () {
    this.timeout(20_000);

    const tempWorkspace = fs.mkdtempSync(
      path.join(os.tmpdir(), 'django-orm-intellisense-legacy-python-path-')
    );

    await removeWorkspaceFoldersFrom(0);
    await addWorkspaceFolder(tempWorkspace);

    const originalSettings = readWorkspaceSettings(tempWorkspace);

    try {
      const legacyInterpreter = path.join(tempWorkspace, 'venv', 'bin', 'python');
      fs.mkdirSync(path.dirname(legacyInterpreter), { recursive: true });
      fs.writeFileSync(legacyInterpreter, '#!/usr/bin/env python3\n');

      if (process.platform !== 'win32') {
        fs.chmodSync(legacyInterpreter, 0o755);
      }

      writeWorkspaceSettings(tempWorkspace, {
        ...originalSettings,
        'djangoOrmIntellisense.pythonPath': legacyInterpreter,
      });
      await delay(300);

      const interpreter = await resolvePythonInterpreter({
        settingsModule: undefined,
        workspaceRoot: tempWorkspace,
        logLevel: 'off',
        autoStart: false,
      });

      assert.strictEqual(interpreter.path, legacyInterpreter);
      assert.strictEqual(
        interpreter.source,
        'djangoOrmIntellisense.pythonInterpreter'
      );
      assert.ok(
        interpreter.detail.includes('legacy `djangoOrmIntellisense.pythonPath`'),
        `Expected legacy interpreter detail, received: ${interpreter.detail}`
      );
    } finally {
      writeWorkspaceSettings(tempWorkspace, originalSettings);
      await removeWorkspaceFoldersFrom(0);
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  test('configures and restores managed Pylance diagnostic overrides', async function () {
    this.timeout(20_000);

    const tempWorkspace = fs.mkdtempSync(
      path.join(os.tmpdir(), 'django-orm-intellisense-workspace-')
    );

    await removeWorkspaceFoldersFrom(0);
    await addWorkspaceFolder(tempWorkspace);

    const originalSettings = readWorkspaceSettings(tempWorkspace);
    const originalOverrides =
      (originalSettings['python.analysis.diagnosticSeverityOverrides'] as
        | Record<string, string>
        | undefined) ?? {};

    try {
      writeWorkspaceSettings(tempWorkspace, {
        ...originalSettings,
        'python.analysis.diagnosticSeverityOverrides': {
          ...originalOverrides,
          reportUnusedImport: 'warning',
        },
      });

      await vscode.commands.executeCommand(
        'djangoOrmIntellisense.configurePylanceDiagnostics',
        'recommended'
      );

      const recommendedOverrides =
        (readWorkspaceSettings(tempWorkspace)[
          'python.analysis.diagnosticSeverityOverrides'
        ] as Record<string, string> | undefined) ?? {};
      assert.strictEqual(
        recommendedOverrides.reportAttributeAccessIssue,
        'warning'
      );
      assert.strictEqual(recommendedOverrides.reportCallIssue, 'warning');
      assert.strictEqual(
        recommendedOverrides.reportUnknownMemberType,
        'information'
      );
      assert.strictEqual(recommendedOverrides.reportUnusedImport, 'warning');

      await vscode.commands.executeCommand(
        'djangoOrmIntellisense.configurePylanceDiagnostics',
        'restore'
      );

      const restoredOverrides =
        (readWorkspaceSettings(tempWorkspace)[
          'python.analysis.diagnosticSeverityOverrides'
        ] as Record<string, string> | undefined) ?? {};
      assert.strictEqual(
        restoredOverrides.reportAttributeAccessIssue,
        undefined
      );
      assert.strictEqual(restoredOverrides.reportCallIssue, undefined);
      assert.strictEqual(restoredOverrides.reportUnusedImport, 'warning');
    } finally {
      writeWorkspaceSettings(tempWorkspace, originalSettings);
      await removeWorkspaceFoldersFrom(0);
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  test('resolves snake_case variable names to PascalCase model names as fallback', async function () {
    this.timeout(20_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );

    // snake_case variable "company" from unresolvable source → Company model fallback
    const companyFilterPosition = positionAfterTextInContainer(
      document,
      "company.question_thread_set.filter(ti='fallback')",
      'ti'
    );
    const companyFilterCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        companyFilterPosition
      );

    assert.ok(
      hasCompletionItemLabel(companyFilterCompletionList?.items, 'title'),
      'Expected snake_case fallback to resolve "company" → Company and complete reverse relation keyword lookup with `title`.'
    );

    // snake_case variable "question_thread" from unresolvable source → QuestionThread model fallback
    const questionThreadFilterPosition = positionAfterTextInContainer(
      document,
      "question_thread.message_set.filter(co='fallback')",
      'co'
    );
    const questionThreadFilterCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        questionThreadFilterPosition
      );

    assert.ok(
      hasCompletionItemLabel(questionThreadFilterCompletionList?.items, 'content'),
      'Expected snake_case fallback to resolve "question_thread" → QuestionThread and complete reverse relation keyword lookup with `content`.'
    );

    // Chained resolution: snake_case fallback → reverse relation → .get() → reverse relation
    const chainFilterPosition = positionAfterTextInContainer(
      document,
      "qt.message_set.filter(co='chain')",
      'co'
    );
    const chainFilterCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        chainFilterPosition
      );

    assert.ok(
      hasCompletionItemLabel(chainFilterCompletionList?.items, 'content'),
      'Expected chained snake_case fallback resolution to complete `content` through company → question_thread_set.get() → message_set.filter().'
    );
  });
});

async function setWorkspaceRoot(rootPath: string): Promise<void> {
  const e2eEnvironment = await ensureFixtureE2EEnvironment(rootPath);

  if (!e2eEnvironment) {
    await updateExtensionSetting('workspaceRoot', rootPath);
    await delay(1200);
    return;
  }

  const fixtureWorkspace = ensureFixtureWorkspace(rootPath, e2eEnvironment);
  const daemon = getActiveDaemonForTesting();
  assert.ok(daemon, 'Expected the analysis daemon to be active after extension activation.');
  const activeWorkspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (activeWorkspaceFolder !== fixtureWorkspace) {
    await removeWorkspaceFoldersFrom(0);
    await addWorkspaceFolder(fixtureWorkspace);
  }
  await applyFixtureWorkspaceSettings(fixtureWorkspace, rootPath, e2eEnvironment);
  const initialSnapshot = await daemon.restart(vscode.Uri.file(fixtureWorkspace));
  const snapshot =
    initialSnapshot.phase === 'ready' &&
    initialSnapshot.runtime?.bootstrapStatus === 'ready'
      ? initialSnapshot
      : await waitForHealthSnapshot(
          daemon,
          (candidate) =>
            candidate.phase === 'ready' &&
            candidate.runtime?.bootstrapStatus === 'ready',
          30_000
        );
  assertFixtureE2EHealth(snapshot, rootPath, e2eEnvironment);
  await delay(300);
}

async function setPythonInterpreter(interpreter: string): Promise<void> {
  await updateExtensionSetting('pythonInterpreter', interpreter);
  await delay(1200);
}

async function setSettingsModule(
  settingsModule: string | undefined
): Promise<void> {
  await updateExtensionSetting('settingsModule', settingsModule);
  await delay(1200);
}

function configurationTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : vscode.ConfigurationTarget.Global;
}

function extensionConfigurationScope(): vscode.ConfigurationScope | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function defaultTestInterpreter(): string {
  if (process.platform === 'win32') {
    return 'python';
  }

  for (const candidate of [
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
  ]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return 'python3';
}

async function updateExtensionSetting(
  key: 'workspaceRoot' | 'pythonInterpreter' | 'settingsModule',
  value: string | undefined
): Promise<void> {
  await vscode.workspace
    .getConfiguration('djangoOrmIntellisense', extensionConfigurationScope())
    .update(key, value, configurationTarget());
}

async function clearExtensionSetting(
  key: 'workspaceRoot' | 'pythonInterpreter' | 'settingsModule'
): Promise<void> {
  await updateExtensionSetting(key, undefined);
}

async function ensureFixtureE2EEnvironment(
  rootPath: string
): Promise<FixtureE2EEnvironment | undefined> {
  const fixtureName = fixtureProjectName(rootPath);
  if (!fixtureName) {
    return undefined;
  }

  const cachedEnvironment = fixtureE2EEnvironmentCache.get(rootPath);
  if (
    cachedEnvironment &&
    fs.existsSync(cachedEnvironment.interpreterPath) &&
    djangoMajorVersion(cachedEnvironment.djangoVersion) === DJANGO_E2E_MAJOR_VERSION
  ) {
    return cachedEnvironment;
  }

  const projectConfig = FIXTURE_E2E_PROJECTS[fixtureName];
  assert.ok(
    projectConfig,
    `Missing E2E fixture configuration for ${fixtureName}.`
  );

  const baseInterpreter = await findDjango5BaseInterpreter();
  if (await isVirtualEnvironmentInterpreter(baseInterpreter)) {
    const djangoVersion = await readDjangoVersion(baseInterpreter);
    assert.ok(
      djangoVersion,
      `Expected ${baseInterpreter} to import Django for E2E bootstrap.`
    );
    assert.strictEqual(
      djangoMajorVersion(djangoVersion),
      DJANGO_E2E_MAJOR_VERSION,
      `Expected ${baseInterpreter} to provide Django ${DJANGO_E2E_MAJOR_VERSION}.x, received ${djangoVersion}.`
    );

    const environment: FixtureE2EEnvironment = {
      ...projectConfig,
      interpreterPath: baseInterpreter,
      djangoVersion,
    };
    fixtureE2EEnvironmentCache.set(rootPath, environment);
    return environment;
  }

  const environmentRoot = path.join(
    os.tmpdir(),
    'django-orm-intellisense-e2e',
    `${fixtureName}-${E2E_PROCESS_TAG}`
  );
  const interpreterPath =
    process.platform === 'win32'
      ? path.join(environmentRoot, 'Scripts', 'python.exe')
      : path.join(environmentRoot, 'bin', 'python');
  const metadataPath = path.join(environmentRoot, '.djls-e2e-base-python');
  const needsRebuild =
    !fs.existsSync(interpreterPath) ||
    readFileIfExists(metadataPath)?.trim() !== baseInterpreter ||
    djangoMajorVersion((await readDjangoVersion(interpreterPath)) ?? '') !==
      DJANGO_E2E_MAJOR_VERSION;

  if (needsRebuild) {
    fs.rmSync(environmentRoot, { recursive: true, force: true });
    await execFileAsync(
      baseInterpreter,
      ['-m', 'venv', '--system-site-packages', '--without-pip', environmentRoot],
    );
    fs.writeFileSync(metadataPath, `${baseInterpreter}\n`, 'utf8');
  }

  const djangoVersion = await readDjangoVersion(interpreterPath);
  assert.ok(
    djangoVersion,
    `Expected ${interpreterPath} to import Django after E2E bootstrap.`
  );
  assert.strictEqual(
    djangoMajorVersion(djangoVersion),
    DJANGO_E2E_MAJOR_VERSION,
    `Expected ${interpreterPath} to provide Django ${DJANGO_E2E_MAJOR_VERSION}.x, received ${djangoVersion}.`
  );

  const environment: FixtureE2EEnvironment = {
    ...projectConfig,
    interpreterPath,
    djangoVersion,
  };
  fixtureE2EEnvironmentCache.set(rootPath, environment);
  return environment;
}

function ensureFixtureWorkspace(
  rootPath: string,
  environment: FixtureE2EEnvironment
): string {
  if (!fixtureHarnessWorkspacePath) {
    fixtureHarnessWorkspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'django-orm-intellisense-e2e-workspace-')
    );
  }

  writeFixtureWorkspaceSettings(fixtureHarnessWorkspacePath, rootPath, environment);
  return fixtureHarnessWorkspacePath;
}

function writeFixtureWorkspaceSettings(
  workspacePath: string,
  rootPath: string,
  environment: FixtureE2EEnvironment
): void {
  writeWorkspaceSettings(workspacePath, {
    'djangoOrmIntellisense.workspaceRoot': rootPath,
    'djangoOrmIntellisense.pythonInterpreter': environment.interpreterPath,
    'djangoOrmIntellisense.settingsModule': environment.settingsModule,
  });
}

async function applyFixtureWorkspaceSettings(
  workspacePath: string,
  rootPath: string,
  environment: FixtureE2EEnvironment
): Promise<void> {
  const configuration = vscode.workspace.getConfiguration(
    'djangoOrmIntellisense',
    vscode.Uri.file(workspacePath)
  );

  await retryWorkspaceFolderUpdate(
    () =>
      configuration.update(
        'workspaceRoot',
        rootPath,
        vscode.ConfigurationTarget.WorkspaceFolder
      )
  );
  await retryWorkspaceFolderUpdate(
    () =>
      configuration.update(
        'pythonInterpreter',
        environment.interpreterPath,
        vscode.ConfigurationTarget.WorkspaceFolder
      )
  );
  await retryWorkspaceFolderUpdate(
    () =>
      configuration.update(
        'settingsModule',
        environment.settingsModule,
        vscode.ConfigurationTarget.WorkspaceFolder
      )
  );
}

function fixtureProjectName(rootPath: string): string | undefined {
  const resolvedRoot = path.resolve(rootPath);
  const relativeRoot = path.relative(FIXTURES_ROOT, resolvedRoot);
  if (
    relativeRoot.startsWith('..') ||
    path.isAbsolute(relativeRoot) ||
    relativeRoot.length === 0
  ) {
    return undefined;
  }

  const [fixtureName] = relativeRoot.split(path.sep);
  return fixtureName && FIXTURE_E2E_PROJECTS[fixtureName]
    ? fixtureName
    : undefined;
}

async function findDjango5BaseInterpreter(): Promise<string> {
  if (django5BaseInterpreterCache) {
    return django5BaseInterpreterCache;
  }

  for (const candidate of django5BaseInterpreterCandidates()) {
    const djangoVersion = await readDjangoVersion(candidate);
    if (djangoMajorVersion(djangoVersion ?? '') !== DJANGO_E2E_MAJOR_VERSION) {
      continue;
    }

    django5BaseInterpreterCache = candidate;
    return candidate;
  }

  assert.fail(
    `Could not find a Python interpreter with Django ${DJANGO_E2E_MAJOR_VERSION}.x. ` +
      'Set DJLS_E2E_BASE_PYTHON or install Django 5 into a discoverable interpreter.'
  );
}

function django5BaseInterpreterCandidates(): string[] {
  const candidates = new Set<string>();
  const envOverride = process.env.DJLS_E2E_BASE_PYTHON;
  if (envOverride) {
    candidates.add(envOverride);
  }

  addAsdfPythonInterpreterCandidates(candidates);

  // Project-local e2e venvs (e.g. .e2e-homebrew313)
  const projectRoot = path.resolve(__dirname, '../..');
  try {
    for (const entry of fs.readdirSync(projectRoot)) {
      if (entry.startsWith('.e2e-')) {
        candidates.add(path.join(projectRoot, entry, 'bin', 'python'));
        candidates.add(path.join(projectRoot, entry, 'bin', 'python3'));
      }
    }
  } catch (e) {
    console.warn('[test] e2e venv discovery failed:', e);
  }

  const homeDirectory = os.homedir();
  const pyenvVersionsRoot = path.join(homeDirectory, '.pyenv', 'versions');
  if (fs.existsSync(pyenvVersionsRoot)) {
    for (const versionName of fs.readdirSync(pyenvVersionsRoot)) {
      candidates.add(path.join(pyenvVersionsRoot, versionName, 'bin', 'python'));
    }
  }

  const desktopProjectsRoot = path.join(homeDirectory, 'Desktop', 'project');
  if (fs.existsSync(desktopProjectsRoot)) {
    for (const projectName of fs.readdirSync(desktopProjectsRoot)) {
      candidates.add(
        path.join(desktopProjectsRoot, projectName, 'venv', 'bin', 'python')
      );
      candidates.add(
        path.join(desktopProjectsRoot, projectName, '.venv', 'bin', 'python')
      );
    }
  }

  candidates.add(defaultTestInterpreter());
  return [...candidates].filter((candidate) => fs.existsSync(candidate));
}

function addAsdfPythonInterpreterCandidates(candidates: Set<string>): void {
  const homeDirectory = os.homedir();
  const asdfInstallsRoot = path.join(homeDirectory, '.asdf', 'installs', 'python');
  if (!fs.existsSync(asdfInstallsRoot)) {
    return;
  }

  const configuredVersion = readAsdfPythonVersionFromToolVersions();
  if (configuredVersion) {
    for (const binaryName of ['python', 'python3', `python${configuredVersion}`]) {
      candidates.add(path.join(asdfInstallsRoot, configuredVersion, 'bin', binaryName));
    }
  }

  for (const versionName of fs.readdirSync(asdfInstallsRoot)) {
    candidates.add(path.join(asdfInstallsRoot, versionName, 'bin', 'python'));
    candidates.add(path.join(asdfInstallsRoot, versionName, 'bin', 'python3'));
  }
}

function readAsdfPythonVersionFromToolVersions(): string | undefined {
  const toolVersionsPath = path.resolve(__dirname, '../../.tool-versions');
  const toolVersions = readFileIfExists(toolVersionsPath);
  const match = toolVersions?.match(/^python\s+([^\s]+)$/m);
  return match?.[1];
}

async function readDjangoVersion(
  interpreterPath: string
): Promise<string | undefined> {
  if (!fs.existsSync(interpreterPath)) {
    return undefined;
  }

  try {
    const output = await execFileAsync(
      interpreterPath,
      [
        '-c',
        "import importlib.util; spec=importlib.util.find_spec('django'); print(__import__('django').get_version() if spec else '')",
      ],
    );
    return output || undefined;
  } catch (e) {
    console.warn('[test] Django version detection failed:', e);
    return undefined;
  }
}

async function isVirtualEnvironmentInterpreter(
  interpreterPath: string
): Promise<boolean> {
  if (!fs.existsSync(interpreterPath)) {
    return false;
  }

  try {
    const output = await execFileAsync(interpreterPath, [
      '-c',
      "import sys; print('1' if getattr(sys, 'real_prefix', None) or sys.prefix != getattr(sys, 'base_prefix', sys.prefix) else '0')",
    ]);
    return output === '1';
  } catch (e) {
    console.warn('[test] venv check failed:', e);
    return false;
  }
}

function execFileAsync(
  file: string,
  args: readonly string[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function djangoMajorVersion(version: string): number | undefined {
  const match = version.match(/^(\d+)\./);
  return match ? Number(match[1]) : undefined;
}

function readFileIfExists(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  return fs.readFileSync(filePath, 'utf8');
}

function assertFixtureE2EHealth(
  snapshot: HealthSnapshot,
  rootPath: string,
  environment: FixtureE2EEnvironment
): void {
  assert.strictEqual(
    normalizeRealPath(snapshot.workspaceRoot),
    normalizeRealPath(rootPath)
  );
  assert.strictEqual(snapshot.pythonPath, environment.interpreterPath);
  assert.strictEqual(snapshot.settingsModule, environment.settingsModule);
  assert.strictEqual(snapshot.phase, 'ready');
  assert.ok(snapshot.runtime, 'Expected runtime inspection details in E2E fixture health.');
  assert.strictEqual(snapshot.runtime?.djangoImportable, true);
  assert.strictEqual(snapshot.runtime?.bootstrapStatus, 'ready');
  assert.strictEqual(snapshot.runtime?.settingsModule, environment.settingsModule);
  assert.ok(
    snapshot.runtime?.djangoVersion?.startsWith(`${DJANGO_E2E_MAJOR_VERSION}.`),
    `Expected Django ${DJANGO_E2E_MAJOR_VERSION}.x in runtime health. Received: ${snapshot.runtime?.djangoVersion}`
  );
}

function normalizeRealPath(targetPath: string | undefined): string | undefined {
  if (!targetPath) {
    return targetPath;
  }

  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
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
  const fullText = document.getText();
  const containerOffset = fullText.indexOf(container);
  assert.ok(containerOffset >= 0, `Could not find container text: ${container}`);
  const containerEndOffset = containerOffset + container.length;
  const targetOffset = fullText.lastIndexOf(target, containerEndOffset);
  assert.ok(targetOffset >= 0, `Could not find target text: ${target}`);
  assert.ok(
    targetOffset >= containerOffset &&
      targetOffset + target.length <= containerEndOffset,
    `Target text "${target}" was not found inside container text: ${container}`
  );
  return document.positionAt(targetOffset + target.length);
}

function positionInsideText(
  document: vscode.TextDocument,
  container: string,
  target: string
): vscode.Position {
  const fullText = document.getText();
  const containerOffset = fullText.indexOf(container);
  assert.ok(containerOffset >= 0, `Could not find container text: ${container}`);
  const containerEndOffset = containerOffset + container.length;
  const targetOffset = fullText.lastIndexOf(target, containerEndOffset);
  assert.ok(targetOffset >= 0, `Could not find target text: ${target}`);
  assert.ok(
    targetOffset >= containerOffset &&
      targetOffset + target.length <= containerEndOffset,
    `Target text "${target}" was not found inside container text: ${container}`
  );
  return document.positionAt(targetOffset + Math.floor(target.length / 2));
}

function completionItemLabel(item: vscode.CompletionItem): string {
  return completionItemDisplayLabel(item).replace(/\s+\([^)]+\)$/, '');
}

function completionItemDisplayLabel(item: vscode.CompletionItem): string {
  return typeof item.label === 'string' ? item.label : item.label.label;
}

function completionItemLabelDetail(
  item: vscode.CompletionItem
): string | undefined {
  return typeof item.label === 'string' ? undefined : item.label.detail;
}

function completionItemDescription(
  item: vscode.CompletionItem
): string | undefined {
  return typeof item.label === 'string' ? undefined : item.label.description;
}

function completionItemFilterValue(item: vscode.CompletionItem): string {
  return item.filterText ?? completionItemLabel(item);
}

function hasCompletionItemLabel(
  items: readonly vscode.CompletionItem[] | undefined,
  label: string
): boolean {
  return (items ?? []).some((item) => completionItemLabel(item) === label);
}

function findCompletionItemByLabel(
  items: readonly vscode.CompletionItem[] | undefined,
  label: string
): vscode.CompletionItem | undefined {
  return (items ?? []).find((item) => completionItemLabel(item) === label);
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

function activeSignatureParameterLabel(
  signatureHelp: vscode.SignatureHelp | undefined
): string | undefined {
  if (!signatureHelp) {
    return undefined;
  }

  const signature =
    signatureHelp.signatures[signatureHelp.activeSignature ?? 0] ??
    signatureHelp.signatures[0];
  if (!signature) {
    return undefined;
  }

  const parameter =
    signature.parameters[signatureHelp.activeParameter ?? 0] ??
    signature.parameters[0];
  if (!parameter) {
    return undefined;
  }

  return Array.isArray(parameter.label)
    ? signature.label.slice(parameter.label[0], parameter.label[1])
    : parameter.label;
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

function bestDefinitionForFixture(
  definitions: Array<vscode.Location | vscode.LocationLink> | undefined,
  fixturePathSuffix: string
): vscode.Location | undefined {
  if (!definitions || definitions.length === 0) {
    return undefined;
  }

  for (const def of definitions) {
    const uri = 'targetUri' in def ? def.targetUri : def.uri;
    if (uri.fsPath.includes(fixturePathSuffix)) {
      if ('targetUri' in def) {
        return new vscode.Location(
          def.targetUri,
          (def as vscode.LocationLink).targetSelectionRange ??
            (def as vscode.LocationLink).targetRange
        );
      }
      return def as vscode.Location;
    }
  }

  return firstDefinition(definitions);
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

  const finalDiagnostics = vscode.languages.getDiagnostics(uri);
  if (!predicate(finalDiagnostics)) {
    assert.fail(
      `waitForDiagnostics timed out after ${timeoutMs}ms. ` +
      `Current diagnostics: ${stringifyDiagnostics(finalDiagnostics)}`
    );
  }
  return finalDiagnostics;
}

async function waitForHealthSnapshot(
  daemon: NonNullable<ReturnType<typeof getActiveDaemonForTesting>>,
  predicate: (snapshot: HealthSnapshot) => boolean,
  timeoutMs = 10_000
): Promise<HealthSnapshot> {
  const startedAt = Date.now();
  let snapshot = daemon.getState();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate(snapshot)) {
      return snapshot;
    }

    await delay(200);
    snapshot = await daemon.refreshHealth();
  }

  assert.fail(
    `Health snapshot was not satisfied within ${timeoutMs}ms. Last snapshot: ${JSON.stringify(snapshot)}`
  );
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 10_000
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(200);
  }

  assert.fail(`Condition was not satisfied within ${timeoutMs}ms.`);
}

function stringifyDiagnostics(items: readonly vscode.Diagnostic[]): string {
  return items.map((item) => item.message).join(' | ');
}

async function addWorkspaceFolder(rootPath: string): Promise<void> {
  let updated = false;
  for (let attempt = 0; attempt < 10 && !updated; attempt += 1) {
    updated =
      vscode.workspace.updateWorkspaceFolders(
        0,
        0,
        {
          uri: vscode.Uri.file(rootPath),
          name: path.basename(rootPath),
        }
      ) ?? false;
    if (!updated) {
      await delay(100);
    }
  }
  assert.ok(updated, `Failed to add workspace folder: ${rootPath}`);
  await waitForCondition(
    () =>
      vscode.workspace.workspaceFolders?.some(
        (folder) => folder.uri.fsPath === rootPath
      ) ?? false,
    5_000
  );
}

async function removeWorkspaceFoldersFrom(startIndex: number): Promise<void> {
  const currentCount = vscode.workspace.workspaceFolders?.length ?? 0;
  if (currentCount <= startIndex) {
    return;
  }

  let updated = false;
  for (let attempt = 0; attempt < 10 && !updated; attempt += 1) {
    updated =
      vscode.workspace.updateWorkspaceFolders(
        startIndex,
        currentCount - startIndex
      ) ?? false;
    if (!updated) {
      await delay(100);
    }
  }
  assert.ok(updated, 'Failed to remove temporary workspace folders.');
  await waitForCondition(
    () => (vscode.workspace.workspaceFolders?.length ?? 0) <= startIndex,
    5_000
  );
}

async function retryWorkspaceFolderUpdate(
  operation: () => Thenable<void>
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }

  throw lastError;
}

async function withProcessEnv(
  name: string,
  value: string,
  callback: () => Promise<void>
): Promise<void> {
  const previousValue = process.env[name];
  process.env[name] = value;
  try {
    await callback();
  } finally {
    if (previousValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previousValue;
    }
  }
}

function workspaceSettingsPath(rootPath: string): string {
  return path.join(rootPath, '.vscode', 'settings.json');
}

function readWorkspaceSettings(rootPath: string): Record<string, unknown> {
  const settingsPath = workspaceSettingsPath(rootPath);
  if (!fs.existsSync(settingsPath)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
}

function writeWorkspaceSettings(
  rootPath: string,
  settings: Record<string, unknown>
): void {
  const settingsPath = workspaceSettingsPath(rootPath);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function copyDirectory(sourcePath: string, targetPath: string): void {
  fs.cpSync(sourcePath, targetPath, { recursive: true });
}
