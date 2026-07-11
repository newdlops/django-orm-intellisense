import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getActiveDaemonForTesting,
  promotePythonProvidersForTesting,
} from '../client/extension';
import {
  clearDiagnosticLogBufferForTesting,
  getDiagnosticLogBufferForTesting,
  clearDaemonModelLabelByNameForTesting,
  dropModelFromAllIndicesForTesting,
} from '../client/daemon/analysisDaemon';
import {
  getActiveDiagnosticScanRunningCountForTesting,
  clearReceiverAndLookupCachesForTesting,
  simulateDaemonReadyCacheClearForTesting,
  classifyNoRecvReasonForTesting,
} from '../client/providers/pythonProviders';
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
  suiteSetup(async function () {
    this.timeout(120_000);
    testCacheRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'django-orm-intellisense-test-cache-')
    );
    process.env.DJANGO_ORM_INTELLISENSE_CACHE_DIR = testCacheRoot;
    process.env.DJLS_DISABLE_AUTO_RESTARTS = '1';
    process.env.DJLS_DISABLE_PROVIDER_TIMEOUT = '1';
    process.env.DJLS_TEST_CAPTURE_LOGS = '1';
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension ${EXTENSION_ID} is not available.`);
    await extension.activate();

    const pylance = vscode.extensions.getExtension('ms-python.vscode-pylance');
    assert.ok(
      pylance,
      'Pylance (ms-python.vscode-pylance) must be installed for the stub-override competition E2E. Install it in the host machine extensions dir.'
    );
    await pylance.activate();

    const msPython = vscode.extensions.getExtension('ms-python.python');
    assert.ok(
      msPython,
      'Microsoft Python (ms-python.python) must be installed so the test environment mirrors the real Pylance+Python-extension setup.'
    );
    await msPython.activate();
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
    delete process.env.DJLS_TEST_CAPTURE_LOGS;
    delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
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
    // P2: the inferred terminal Python type of the `A__B__C` chain (C is a
    // CharField, so `str`) is surfaced alongside the Django field kind.
    assert.ok(
      hoverText.includes('Resulting type: `str`'),
      `Expected lookup hover to mention the inferred terminal python type. Received: ${hoverText}`
    );

    // #1: inlay hints surface the inferred lookup type inline at the kwarg.
    // query_examples.py line ~39: filter(author__profile__timezone='Asia/Seoul')
    // resolves to a CharField terminal, so a `: str` type hint appears.
    const inlayHints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
      'vscode.executeInlayHintProvider',
      document.uri,
      new vscode.Range(0, 0, document.lineCount, 0)
    );
    const inlayLabels = (inlayHints ?? []).map((hint) =>
      typeof hint.label === 'string'
        ? hint.label
        : hint.label.map((part) => part.value).join('')
    );
    assert.ok(
      inlayLabels.some((label) => label.includes('str')),
      `Expected an inlay hint with the inferred lookup type (e.g. ': str'). Received: ${JSON.stringify(inlayLabels)}`
    );

    // Root-cause fix A: a custom QuerySet method (`open_only`, returns Self)
    // must keep the model so the following filter resolves to QuestionThread
    // fields (e.g. `title`) instead of failing/timing out.
    const customMethodCompletionPosition = positionAfterTextInContainer(
      document,
      "QuestionThread.objects.open_only().filter(ti='x')",
      'filter(ti'
    );
    const customMethodCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        customMethodCompletionPosition
      );
    assert.ok(
      hasCompletionItemLabel(customMethodCompletionList?.items ?? [], 'title'),
      'Expected a custom QuerySet method chain (open_only().filter) to resolve to QuestionThread fields.'
    );

    // Root-cause fix C: a self-reassigned queryset (`qs = qs.filter(...)`) must
    // resolve back to its origin (`QuestionThread.objects.all()`).
    const selfReassignCompletionPosition = positionAfterTextInContainer(
      document,
      "qs.filter(ti='x')",
      'filter(ti'
    );
    const selfReassignCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        selfReassignCompletionPosition
      );
    assert.ok(
      hasCompletionItemLabel(selfReassignCompletionList?.items ?? [], 'title'),
      'Expected a self-reassigned queryset to resolve back to its origin model (QuestionThread).'
    );

    // Root-cause fix B: a variable from a function annotated `-> <Model>QuerySet`
    // must resolve to that model.
    const returnAnnotationCompletionPosition = positionAfterTextInContainer(
      document,
      "threads.filter(ti='x')",
      'filter(ti'
    );
    const returnAnnotationCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        returnAnnotationCompletionPosition
      );
    assert.ok(
      hasCompletionItemLabel(returnAnnotationCompletionList?.items ?? [], 'title'),
      'Expected a `-> QuestionThreadQuerySet` return annotation to resolve the variable to QuestionThread.'
    );

    // #2b: a custom `annotate_*` method that adds `.annotate(_message_count=...)`
    // must surface `_message_count` as a virtual lookup field.
    const annotateMethodCompletionPosition = positionAfterTextInContainer(
      document,
      'QuestionThread.objects.annotate_message_count().filter(_message_count__gte=1)',
      'filter(_mess'
    );
    const annotateMethodCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        annotateMethodCompletionPosition
      );
    assert.ok(
      hasCompletionItemLabel(
        annotateMethodCompletionList?.items ?? [],
        '_message_count'
      ),
      'Expected a custom annotate_* method to surface its annotated virtual field (_message_count).'
    );

    // #2c: the real-world failing shape — a function-return receiver + custom
    // annotate_* method stored in a *variable*, then filtered in a *separate
    // statement*. The annotated virtual field must survive variable resolution.
    const variableAnnotateCompletionPosition = positionAfterTextInContainer(
      document,
      'chained_qs.filter(_message_count__gte=1)',
      'filter(_mess'
    );
    const variableAnnotateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        variableAnnotateCompletionPosition
      );
    assert.ok(
      hasCompletionItemLabel(
        variableAnnotateCompletionList?.items ?? [],
        '_message_count'
      ),
      'Expected a variable holding a custom annotate_* chain to surface its annotated virtual field (_message_count).'
    );

    // #2c (DEEP): a 6+ link custom annotate_* chain stored in a variable. The
    // deepest annotated field (_job_role_name) must survive deep receiver
    // resolution. Reproduces the real-world hrm_emp_qs failure where the chain
    // depth exhausted the visited-set cap and dropped virtual fields.
    const deepAnnotateCompletionPosition = positionAfterTextInContainer(
      document,
      'deep_qs.filter(_job_role_name__icontains="x")',
      'filter(_job_role'
    );
    const deepAnnotateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        deepAnnotateCompletionPosition
      );
    assert.ok(
      hasCompletionItemLabel(
        deepAnnotateCompletionList?.items ?? [],
        '_job_role_name'
      ),
      'Expected a DEEP custom annotate_* chain to surface its deepest annotated virtual field (_job_role_name).'
    );

    // #2c ROOT CAUSE: the exact real-world `hrm_emp_qs` shape — a self-
    // reassignment chain (`qs = qs.annotate_*()...` then `qs = qs.filter(...)`).
    // The annotated virtual field must survive the self-reassignment walk so the
    // final-statement filter resolves it.
    const selfReassignAnnotateCompletionPosition = positionAfterTextInContainer(
      document,
      'qs.filter(_job_role_name__icontains="selfreassign")',
      'filter(_job_role'
    );
    const selfReassignAnnotateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        selfReassignAnnotateCompletionPosition
      );
    assert.ok(
      hasCompletionItemLabel(
        selfReassignAnnotateCompletionList?.items ?? [],
        '_job_role_name'
      ),
      'Expected a SELF-REASSIGNMENT annotate_* chain to surface its annotated virtual field (_job_role_name).'
    );

    // #2c ROOT CAUSE (cross-module + function-local import): the closest mirror
    // of the real `hrm_emp_qs` failure — receiver from a function-locally
    // imported, cross-module helper, self-reassigned annotate chain, filters in
    // `if` blocks. The annotated virtual field must survive.
    const crossModuleAnnotateCompletionPosition = positionAfterTextInContainer(
      document,
      'cmod_qs.filter(_job_role_name__icontains="crossmod")',
      'filter(_job_role'
    );
    const crossModuleAnnotateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        crossModuleAnnotateCompletionPosition
      );
    assert.ok(
      hasCompletionItemLabel(
        crossModuleAnnotateCompletionList?.items ?? [],
        '_job_role_name'
      ),
      'Expected a CROSS-MODULE function-local-import annotate_* chain to surface its annotated virtual field (_job_role_name).'
    );

    // #2c (instance-classified receiver): a function returning a bare model
    // resolves to an `instance` receiver; a custom annotate_* on it is still a
    // queryset op and must surface its virtual field. Mirrors the real
    // `get_emps(hrm) -> HrmEmpQuerySet` (generic QuerySet[T_co]) which the hover
    // path classifies as `instance`.
    const instanceAnnotateCompletionPosition = positionAfterTextInContainer(
      document,
      'inst_qs.filter(_status__icontains="inst")',
      'filter(_stat'
    );
    const instanceAnnotateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        instanceAnnotateCompletionPosition
      );
    assert.ok(
      hasCompletionItemLabel(
        instanceAnnotateCompletionList?.items ?? [],
        '_status'
      ),
      'Expected an INSTANCE-classified receiver annotate_* chain to surface its annotated virtual field (_status).'
    );

    // @property #1: a computed @property on a model instance must surface in
    // attribute completion (`thread.is_re|` → is_resolved).
    const propertyCompletionPosition = positionAfterTextInContainer(
      document,
      'thread.is_resolved',
      'thread.is'
    );
    const propertyCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        propertyCompletionPosition
      );
    assert.ok(
      hasCompletionItemLabel(propertyCompletionList?.items ?? [], 'is_resolved'),
      'Expected a model @property (is_resolved) to surface in instance attribute completion.'
    );

    // @property #2: hover on a @property must render it as a property member.
    const propertyHoverPosition = positionInsideText(
      document,
      'thread.is_resolved',
      'is_resolved'
    );
    const propertyHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      propertyHoverPosition
    );
    const propertyHoverText = stringifyHovers(propertyHovers);
    assert.ok(
      /property/i.test(propertyHoverText),
      `Expected a @property hover to identify it as a property. Received: ${propertyHoverText}`
    );

    // @property #3 (semantic guard): a @property is NOT a queryable field, so it
    // must NOT be offered in values()/only() string args (only real fields).
    const valuesFieldCompletionPosition = positionAfterTextInContainer(
      document,
      'QuestionThread.objects.values("is_open")',
      'values("is'
    );
    const valuesFieldCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        valuesFieldCompletionPosition
      );
    assert.ok(
      hasCompletionItemLabel(valuesFieldCompletionList?.items ?? [], 'is_open'),
      'Expected the real field is_open to be offered in values().'
    );
    assert.ok(
      !hasCompletionItemLabel(
        valuesFieldCompletionList?.items ?? [],
        'is_resolved'
      ),
      'Expected a @property (is_resolved) to be EXCLUDED from values() field completion (it is not an ORM field).'
    );

    // INSTANCE + interleaved filter chain (the exact real-world get_emps shape):
    // receiver resolves to an instance, filters resolve via the daemon
    // member-chain (no virtualFields), yet the annotated fields must survive via
    // the path-independent assignment-chain collector.
    const instChainStatusPosition = positionAfterTextInContainer(
      document,
      'iq.filter(_status__icontains="instchain")',
      'filter(_stat'
    );
    const instChainStatusList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        instChainStatusPosition
      );
    assert.ok(
      hasCompletionItemLabel(instChainStatusList?.items ?? [], '_status'),
      'Expected _status to survive an instance + interleaved-filter self-reassignment chain.'
    );
    const instChainRolePosition = positionAfterTextInContainer(
      document,
      'iq.filter(_job_role_name__icontains="instchain2")',
      'filter(_job_role'
    );
    const instChainRoleList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        instChainRolePosition
      );
    assert.ok(
      hasCompletionItemLabel(instChainRoleList?.items ?? [], '_job_role_name'),
      'Expected _job_role_name (added after a .filter()) to survive the instance filter chain.'
    );

    // String-literal guard: an annotate-like substring inside a string literal
    // must NOT mint a phantom virtual field, while the real one (_status) does.
    const strLitGuardPosition = positionAfterTextInContainer(
      document,
      'sq.filter(_status__icontains="strlit")',
      'filter(_'
    );
    const strLitGuardList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        strLitGuardPosition
      );
    assert.ok(
      hasCompletionItemLabel(strLitGuardList?.items ?? [], '_status'),
      'Expected the real annotated field (_status) to resolve alongside a string-literal that contains annotate-like text.'
    );
    assert.ok(
      !hasCompletionItemLabel(strLitGuardList?.items ?? [], 'phantom_field'),
      'Expected an annotate(...) substring INSIDE a string literal to NOT mint a phantom virtual field (phantom_field).'
    );

    // related_query_name: a reverse relation addressed by its query name (tmeta,
    // NOT the _tmeta accessor) must resolve THROUGH to the related model's fields.
    const relatedQueryNamePosition = positionAfterTextInContainer(
      document,
      'QuestionThread.objects.values("tmeta__note")',
      'values("tmeta__'
    );
    const relatedQueryNameList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        relatedQueryNamePosition
      );
    assert.ok(
      hasCompletionItemLabel(relatedQueryNameList?.items ?? [], 'note'),
      'Expected a reverse relation addressed by related_query_name (tmeta__) to resolve into the related model fields (note).'
    );

    // Multi-line values(): a field path on a SEPARATE line from `.values(` must
    // still be detected as a lookup and resolve (completion + hover). This is the
    // real-world `.values(\n  "tmeta__note",\n ...)` shape.
    const multilineValuesCompletionPosition = positionAfterTextInContainer(
      document,
      '"tmeta__note"',
      '"tmeta__'
    );
    const multilineValuesCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        multilineValuesCompletionPosition
      );
    assert.ok(
      hasCompletionItemLabel(multilineValuesCompletionList?.items ?? [], 'note'),
      'Expected a multi-line values() field on its own line to resolve the related_query_name path (tmeta__note → note).'
    );
    const multilineValuesHoverPosition = positionInsideText(
      document,
      '"tmeta__note"',
      'tmeta'
    );
    const multilineValuesHovers = await vscode.commands.executeCommand<
      vscode.Hover[]
    >('vscode.executeHoverProvider', document.uri, multilineValuesHoverPosition);
    const multilineValuesHoverText = stringifyHovers(multilineValuesHovers);
    assert.ok(
      /ThreadMeta|tmeta|note|OneToOne|relation/i.test(multilineValuesHoverText),
      `Expected a multi-line values() field path (tmeta__note) to produce a lookup hover. Received: ${multilineValuesHoverText}`
    );

    // User-shaped: variable receiver, .values() WRAPPED in another call, the
    // related_query_name field deep in a long multi-line list (the real failing
    // `pd.DataFrame(hrm_emp_qs.values("...", "salary_account__...", ...))` shape).
    const userShapedValuesHoverPosition = positionInsideText(
      document,
      '"tmeta__thread_id"',
      'tmeta'
    );
    const userShapedValuesHovers = await vscode.commands.executeCommand<
      vscode.Hover[]
    >('vscode.executeHoverProvider', document.uri, userShapedValuesHoverPosition);
    const userShapedValuesHoverText = stringifyHovers(userShapedValuesHovers);
    assert.ok(
      /ThreadMeta|tmeta|thread|note|OneToOne|relation|model/i.test(
        userShapedValuesHoverText
      ),
      `Expected a deep multi-line values() field in a wrapped call to resolve. Received: ${userShapedValuesHoverText}`
    );
    const userShapedValuesCompletionPosition = positionAfterTextInContainer(
      document,
      '"tmeta__thread_id"',
      '"tmeta__'
    );
    const userShapedValuesCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        userShapedValuesCompletionPosition
      );
    assert.ok(
      hasCompletionItemLabel(userShapedValuesCompletionList?.items ?? [], 'note'),
      'Expected completion inside a deep wrapped multi-line values() to resolve the related_query_name path (tmeta__ → note).'
    );

    // IF-BLOCK self-reassignment chain (the EXACT real hrm_emp_qs shape):
    // annotate chain, then if/elif, then a series of `if cond: qs = qs.filter(...)`.
    // Hover/completion on a LATER if-block field must resolve via the self-
    // reassignment walk through the intervening `if`/`elif` lines.
    const ifBlockStatusHoverPos = positionInsideText(
      document,
      'ifqs.filter(_status__in=statuses)',
      '_status'
    );
    const ifBlockStatusHovers = await vscode.commands.executeCommand<
      vscode.Hover[]
    >('vscode.executeHoverProvider', document.uri, ifBlockStatusHoverPos);
    assert.ok(
      /Owner model|HrmEmp|QuestionThread|Field kind|annotat|Resulting/i.test(
        stringifyHovers(ifBlockStatusHovers)
      ),
      `Expected _status in an if-block self-reassignment chain to hover-resolve. Received: ${stringifyHovers(ifBlockStatusHovers)}`
    );
    const ifBlockRoleCompletionPos = positionAfterTextInContainer(
      document,
      'ifqs.filter(_job_role_name__in=roles)',
      'filter(_job_role'
    );
    const ifBlockRoleCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        ifBlockRoleCompletionPos
      );
    assert.ok(
      hasCompletionItemLabel(ifBlockRoleCompletionList?.items ?? [], '_job_role_name'),
      'Expected _job_role_name in a LATER if-block to complete via the self-reassignment walk.'
    );

    // DEEPEST if-block field: many self-reassignment levels deep. The receiver
    // walk must traverse all of them WITHOUT exceeding the visited-set cap (the
    // real hrm_emp_qs failure: deep fields resolved to kind=undefined).
    const deepIfBlockHoverPos = positionInsideText(
      document,
      'ifqs.filter(_status__in=["deepstatus"])',
      '_status'
    );
    const deepIfBlockHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      deepIfBlockHoverPos
    );
    assert.ok(
      /Owner model|HrmEmp|QuestionThread|Field kind|annotat|Resulting/i.test(
        stringifyHovers(deepIfBlockHovers)
      ),
      `Expected the DEEPEST if-block field (_status, many levels deep) to hover-resolve. Received: ${stringifyHovers(deepIfBlockHovers)}`
    );

    // Builtin .annotate(_x=...) directly off objects: _x must resolve as a
    // virtual lookup field (probe for the general builtin-annotate path).
    const builtinAnnotateCompletionPosition = positionAfterTextInContainer(
      document,
      '_builtin_total__gte=1',
      '_builtin_tot'
    );
    const builtinAnnotateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        builtinAnnotateCompletionPosition
      );
    assert.ok(
      hasCompletionItemLabel(
        builtinAnnotateCompletionList?.items ?? [],
        '_builtin_total'
      ),
      'Expected a builtin .annotate(_builtin_total=...) field to surface as a virtual lookup field.'
    );

    // .values().annotate(_sum=...): a builtin annotate AFTER .values() must still
    // surface its virtual field in a later filter.
    const valuesAnnotateCompletionPos = positionAfterTextInContainer(
      document,
      'filter(_values_sum__gte=1)',
      'filter(_values'
    );
    const valuesAnnotateCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        valuesAnnotateCompletionPos
      );
    assert.ok(
      hasCompletionItemLabel(valuesAnnotateCompletionList?.items ?? [], '_values_sum'),
      'Expected a builtin annotate after .values() (_values_sum) to surface as a virtual lookup field.'
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

  test('preserves chained lookup completions through the local fast path', async function () {
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
      await waitForCondition(
        () =>
          Boolean(
            daemon.surfaceIndex['blog.InheritedOnlyLog']?.instance?.created_at
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

      const inheritedLookupCompletionPosition = positionAfterTextInContainer(
        document,
        "InheritedOnlyLog.objects.filter(cr='entry')",
        'cr'
      );
      const inheritedLookupCompletionList =
        await vscode.commands.executeCommand<vscode.CompletionList>(
          'vscode.executeCompletionItemProvider',
          document.uri,
          inheritedLookupCompletionPosition
        );

      assert.ok(
        hasCompletionItemLabel(
          inheritedLookupCompletionList?.items ?? [],
          'created_at'
        ),
        `Expected file-watcher reindex to preserve inherited-only model lookup completion. Received: ${(inheritedLookupCompletionList?.items ?? [])
          .slice(0, 20)
          .map((item) => `${completionItemDisplayLabel(item)} | ${item.detail ?? '<no detail>'}`)
          .join(', ')}`
      );
    } finally {
      await removeWorkspaceFoldersFrom(0);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('reindexes inherited lookup surfaces when an abstract base file changes', async function () {
    this.timeout(30_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    const environment = await ensureFixtureE2EEnvironment(fixtureRoot);
    assert.ok(environment, 'Expected a reusable E2E environment for the fixture project.');

    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'django-orm-intellisense-inheritance-watcher-root-')
    );
    copyDirectory(fixtureRoot, tempRoot);

    const watcherExamplesPath = path.join(
      tempRoot,
      'org',
      'inheritance_watcher_examples.py'
    );
    fs.writeFileSync(
      watcherExamplesPath,
      [
        'from org.models import Vendor',
        '',
        '',
        'def vendor_lookup_examples():',
        "    Vendor.objects.filter(up='watcher')",
        "    Vendor.objects.filter(updated_by__bog='watcher')",
        '',
      ].join('\n'),
      'utf8'
    );

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

      const basePath = path.join(tempRoot, 'org', 'models', 'base.py');
      const originalBase = fs.readFileSync(basePath, 'utf8');
      const updatedBase = originalBase.replace(
        "    class Meta:\n        abstract = True\n",
        "    updated_by = models.CharField(max_length=128, blank=True)\n\n    class Meta:\n        abstract = True\n"
      );
      assert.notStrictEqual(
        updatedBase,
        originalBase,
        'Expected to inject an inherited watcher test field into org.VendorBase.'
      );
      fs.writeFileSync(basePath, updatedBase, 'utf8');

      await waitForCondition(
        () => Boolean(daemon.surfaceIndex['org.Vendor']?.instance?.updated_by),
        15_000
      );

      const document = await openFixtureDocument(
        tempRoot,
        'org/inheritance_watcher_examples.py'
      );
      const completionPosition = positionAfterTextInContainer(
        document,
        "Vendor.objects.filter(up='watcher')",
        'up'
      );
      const completionList =
        await vscode.commands.executeCommand<vscode.CompletionList>(
          'vscode.executeCompletionItemProvider',
          document.uri,
          completionPosition
        );

      assert.ok(
        hasCompletionItemLabel(completionList?.items ?? [], 'updated_by'),
        `Expected file-watcher reindex to propagate abstract-base field additions into inherited lookup completion. Received: ${(completionList?.items ?? [])
          .slice(0, 20)
          .map((item) => `${completionItemDisplayLabel(item)} | ${item.detail ?? '<no detail>'}`)
          .join(', ')}`
      );

      const updatedLookupResolution = await daemon.resolveLookupPath(
        'org.Vendor',
        'updated_by__bog',
        'filter',
        true
      );

      assert.strictEqual(
        updatedLookupResolution.resolved,
        false,
        `Expected file-watcher reindex to propagate abstract-base field additions into inherited lookup resolution. Received: ${JSON.stringify(updatedLookupResolution)}`
      );
      assert.strictEqual(
        updatedLookupResolution.reason,
        'invalid_lookup_operator',
        `Expected file-watcher reindex to treat \`updated_by\` as a resolved inherited field before rejecting \`bog\`. Received: ${JSON.stringify(updatedLookupResolution)}`
      );
      assert.strictEqual(
        updatedLookupResolution.missingSegment,
        'bog',
        `Expected file-watcher reindex to expose the invalid inherited lookup operator segment. Received: ${JSON.stringify(updatedLookupResolution)}`
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
      190,
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
      164,
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

  test('suppresses automatic ORM parameter hints without disabling manual signature help', async function () {
    this.timeout(30_000);

    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);

    const document = await openFixtureDocument(
      fixtureRoot,
      'blog/query_examples.py'
    );
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'Expected the fixture document to be visible.');
    assert.strictEqual(editor!.document.uri.toString(), document.uri.toString());

    let fallbackCalls = 0;
    const fallbackSignatureProvider =
      vscode.languages.registerSignatureHelpProvider(
        // Register a competing provider after the extension, then explicitly
        // promote the extension below to reproduce its ordering ahead of
        // generic Python providers such as Pylance.
        'python',
        {
          provideSignatureHelp() {
            fallbackCalls++;
            const fallbackHelp = new vscode.SignatureHelp();
            fallbackHelp.signatures = [
              new vscode.SignatureInformation('fallback(*args, **kwargs)'),
            ];
            fallbackHelp.activeSignature = 0;
            fallbackHelp.activeParameter = 0;
            return fallbackHelp;
          },
        },
        '(',
        ','
      );

    try {
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        10_000
      );
      await delay(250);
      promotePythonProvidersForTesting('signature-overlap-test');
      await delay(500);

      const filterCall = 'Post.objects.filter()';
      const openParenPosition = positionAfterTextInContainer(
        document,
        filterCall,
        'Post.objects.filter'
      );
      const removeParentheses = new vscode.WorkspaceEdit();
      removeParentheses.delete(
        document.uri,
        new vscode.Range(openParenPosition, openParenPosition.translate(0, 2))
      );
      assert.strictEqual(
        await vscode.workspace.applyEdit(removeParentheses),
        true,
        'Expected the fixture call parentheses to be removed before typing.'
      );

      editor!.selection = new vscode.Selection(
        openParenPosition,
        openParenPosition
      );
      await vscode.commands.executeCommand(
        'workbench.action.focusActiveEditorGroup'
      );
      await vscode.commands.executeCommand('type', { text: '(' });

      // Signature help is delayed by VS Code before providers are queried.
      // Give the real ORM provider enough time to resolve and return its empty
      // automatic result; a missing/undefined result would continue into the
      // lower-priority fallback provider.
      await delay(1_500);
      assert.strictEqual(
        fallbackCalls,
        0,
        'Expected automatic ORM signature help to stop lower-priority providers so no parameter-hints panel can cover autocomplete.'
      );

      await vscode.commands.executeCommand('closeParameterHints');
      if (document.isDirty) {
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      await delay(300);

      const nonOrmCall = 'Post.objects.filter()';
      const receiverEnd = positionAfterTextInContainer(
        document,
        nonOrmCall,
        'Post.objects'
      );
      const nonOrmEdit = new vscode.WorkspaceEdit();
      nonOrmEdit.replace(
        document.uri,
        new vscode.Range(
          receiverEnd.translate(0, -'Post.objects'.length),
          receiverEnd
        ),
        'plain_collection'
      );
      assert.strictEqual(
        await vscode.workspace.applyEdit(nonOrmEdit),
        true,
        'Expected a temporary non-ORM filter receiver for the control case.'
      );
      const nonOrmOpenParen = positionAfterTextInContainer(
        document,
        'plain_collection.filter()',
        'plain_collection.filter'
      );
      const removeNonOrmParentheses = new vscode.WorkspaceEdit();
      removeNonOrmParentheses.delete(
        document.uri,
        new vscode.Range(nonOrmOpenParen, nonOrmOpenParen.translate(0, 2))
      );
      assert.strictEqual(
        await vscode.workspace.applyEdit(removeNonOrmParentheses),
        true,
        'Expected the control call parentheses to be removed before typing.'
      );
      editor!.selection = new vscode.Selection(nonOrmOpenParen, nonOrmOpenParen);
      await vscode.commands.executeCommand('type', { text: '(' });
      await delay(1_500);
      assert.ok(
        fallbackCalls > 0,
        'Expected a non-ORM filter() call to fall through to normal Python signature providers.'
      );

      await vscode.commands.executeCommand('closeParameterHints');
      if (document.isDirty) {
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      fallbackCalls = 0;
      await delay(300);
      const manualSignaturePosition = positionAfterTextInContainer(
        document,
        "Post.objects.create(ti='draft', author_i=1)",
        'ti'
      );

      const manualSignatureHelp =
        await vscode.commands.executeCommand<vscode.SignatureHelp>(
          'vscode.executeSignatureHelpProvider',
          document.uri,
          manualSignaturePosition
        );

      assert.ok(
        manualSignatureHelp?.signatures[0]?.label.includes('create(*,'),
        `Expected explicit Parameter Hints invocation to keep the rich Django ORM signature. Received: ${manualSignatureHelp?.signatures[0]?.label}`
      );
      assert.ok(
        manualSignatureHelp?.signatures[0]?.label.includes('title: CharField'),
        `Expected the explicit ORM signature to include model fields. Received: ${manualSignatureHelp?.signatures[0]?.label}`
      );
      assert.strictEqual(
        fallbackCalls,
        0,
        'Expected the Django ORM provider to handle explicit signature help before the fallback provider.'
      );
    } finally {
      fallbackSignatureProvider.dispose();
      await vscode.commands.executeCommand('closeParameterHints');
      await vscode.window.showTextDocument(document);
      if (document.isDirty) {
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
    }
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

    const inheritedRelatedManagerFilterCompletionPosition =
      positionAfterTextInContainer(
        document,
        "self.company.company_question_thread_set.filter(he='inherited')",
        'filter(he'
      );
    const inheritedRelatedManagerFilterCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        inheritedRelatedManagerFilterCompletionPosition
      );
    assert.ok(
      hasCompletionItemLabel(
        inheritedRelatedManagerFilterCompletionList?.items,
        'help_type'
      ),
      `Expected concrete-inheritance reverse related-manager filter() field completion to include the inherited \`help_type\` field. Received: ${(inheritedRelatedManagerFilterCompletionList?.items ?? [])
        .slice(0, 20)
        .map((item) => `${completionItemDisplayLabel(item)} | ${item.detail ?? '<no detail>'}`)
        .join(', ')}`
    );

    const inheritedRelatedManagerLookupOperatorCompletionPosition =
      positionAfterTextInContainer(
        document,
        "self.company.company_question_thread_set.filter(help_type__i='inherited')",
        'help_type__i'
      );
    const inheritedRelatedManagerLookupOperatorCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        inheritedRelatedManagerLookupOperatorCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        inheritedRelatedManagerLookupOperatorCompletionList?.items,
        'icontains'
      ),
      'Expected concrete-inheritance reverse related-manager lookup-operator completion to include `icontains` for the inherited `help_type` field.'
    );

    const inheritedRelatedManagerExcludeCompletionPosition =
      positionAfterTextInContainer(
        document,
        "self.company.company_question_thread_set.exclude(he='inherited')",
        'exclude(he'
      );
    const inheritedRelatedManagerExcludeCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        inheritedRelatedManagerExcludeCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(
        inheritedRelatedManagerExcludeCompletionList?.items,
        'help_type'
      ),
      'Expected concrete-inheritance reverse related-manager exclude() field completion to include the inherited `help_type` field.'
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

    const inheritedLookupCompletionPosition = positionAfterTextInContainer(
      document,
      "Vendor.objects.filter(cre='demo')",
      'cre'
    );
    const inheritedLookupCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        inheritedLookupCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(inheritedLookupCompletionList?.items, 'created_by'),
      'Expected imported package model lookup completion to include the inherited relation field `created_by`.'
    );

    const inheritedRelatedLookupCompletionPosition = positionAfterTextInContainer(
      document,
      "Vendor.objects.filter(created_by__na='demo')",
      'created_by__na'
    );
    const inheritedRelatedLookupCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        inheritedRelatedLookupCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(inheritedRelatedLookupCompletionList?.items, 'name'),
      'Expected imported package model lookup completion to traverse the inherited relation field `created_by` and include `name`.'
    );
    const inheritedRelatedLookupNameItem = findCompletionItemByLabel(
      inheritedRelatedLookupCompletionList?.items,
      'name'
    );
    assert.strictEqual(
      completionItemFilterValue(inheritedRelatedLookupNameItem!),
      'created_by__name',
      'Expected inherited related lookup completion to preserve the full path for editor filtering.'
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
    assert.ok(
      hasCompletionItemLabel(instanceCompletionList?.items, 'created_by'),
      'Expected imported package model instance completion to include the inherited relation field `created_by`.'
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

    const inheritedOnlyCompletionPosition = positionAfterTextInContainer(
      document,
      "InheritedOnlyLog.objects.filter(cr='entry')",
      'cr'
    );
    const inheritedOnlyCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        inheritedOnlyCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(inheritedOnlyCompletionList?.items, 'created_at'),
      'Expected inheritance-only concrete model keyword lookup completion to include `created_at`.'
    );

    const inheritedOnlyOperatorCompletionPosition =
      positionAfterTextInContainer(
        document,
        'InheritedOnlyLog.objects.filter(created_at__ye=2024)',
        'created_at__ye'
      );
    const inheritedOnlyOperatorCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        inheritedOnlyOperatorCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(inheritedOnlyOperatorCompletionList?.items, 'year'),
      'Expected inheritance-only concrete model lookup operator completion to include `year` for `created_at`.'
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

    const concreteInheritedCompletionPosition = positionAfterTextInContainer(
      document,
      "CompanyQuestionThread.objects.filter(he='inherited')",
      'filter(he'
    );
    const concreteInheritedCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        concreteInheritedCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(concreteInheritedCompletionList?.items, 'help_type'),
      'Expected concrete-inheritance keyword lookup completion to include `help_type`.'
    );

    const concreteInheritedOperatorCompletionPosition =
      positionAfterTextInContainer(
        document,
        "CompanyQuestionThread.objects.filter(help_type__i='inherited')",
        'help_type__i'
      );
    const concreteInheritedOperatorCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        concreteInheritedOperatorCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(concreteInheritedOperatorCompletionList?.items, 'icontains'),
      'Expected concrete-inheritance lookup operator completion to include `icontains` for `help_type`.'
    );

    const concreteInheritedHoverPosition = positionInsideText(
      document,
      "CompanyQuestionThread.objects.filter(help_type__icontains='inherited')",
      'help_type__icontains'
    );
    const concreteInheritedHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        concreteInheritedHoverPosition
      );
    const concreteInheritedHoverText = stringifyHovers(concreteInheritedHovers);

    assert.ok(
      concreteInheritedHoverText.includes('Owner model: `blog.CompanyQuestionThread`'),
      `Expected concrete-inheritance lookup hover to mention blog.CompanyQuestionThread. Received: ${concreteInheritedHoverText}`
    );
    assert.ok(
      concreteInheritedHoverText.includes('Field kind: `CharField`'),
      `Expected concrete-inheritance lookup hover to mention CharField. Received: ${concreteInheritedHoverText}`
    );
    assert.ok(
      concreteInheritedHoverText.includes('Lookup operator: `icontains`'),
      `Expected concrete-inheritance lookup hover to mention the inherited lookup operator. Received: ${concreteInheritedHoverText}`
    );

    const proxyInheritedCompletionPosition = positionAfterTextInContainer(
      document,
      "ProxyRegistrationServiceQuestionThread.objects.filter(he='proxy')",
      'filter(he'
    );
    const proxyInheritedCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        proxyInheritedCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(proxyInheritedCompletionList?.items, 'help_type'),
      'Expected proxy-inheritance keyword lookup completion to include `help_type`.'
    );

    const proxyInheritedOperatorCompletionPosition =
      positionAfterTextInContainer(
        document,
        "ProxyRegistrationServiceQuestionThread.objects.filter(help_type__i='proxy')",
        'help_type__i'
      );
    const proxyInheritedOperatorCompletionList =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        proxyInheritedOperatorCompletionPosition
      );

    assert.ok(
      hasCompletionItemLabel(proxyInheritedOperatorCompletionList?.items, 'icontains'),
      'Expected proxy-inheritance lookup operator completion to include `icontains` for `help_type`.'
    );

    const proxyInheritedHoverPosition = positionInsideText(
      document,
      "ProxyRegistrationServiceQuestionThread.objects.filter(help_type__icontains='proxy')",
      'help_type__icontains'
    );
    const proxyInheritedHovers =
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        proxyInheritedHoverPosition
      );
    const proxyInheritedHoverText = stringifyHovers(proxyInheritedHovers);

    assert.ok(
      proxyInheritedHoverText.includes(
        'Owner model: `blog.ProxyRegistrationServiceQuestionThread`'
      ),
      `Expected proxy-inheritance lookup hover to mention blog.ProxyRegistrationServiceQuestionThread. Received: ${proxyInheritedHoverText}`
    );
    assert.ok(
      proxyInheritedHoverText.includes('Field kind: `CharField`'),
      `Expected proxy-inheritance lookup hover to mention CharField. Received: ${proxyInheritedHoverText}`
    );
    assert.ok(
      proxyInheritedHoverText.includes('Lookup operator: `icontains`'),
      `Expected proxy-inheritance lookup hover to mention the inherited lookup operator. Received: ${proxyInheritedHoverText}`
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

    const inheritedLookupDiagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) => item.message.includes('created_at__bog')) &&
        items.some((item) => item.message.includes('help_type__bog'))
    );

    assert.ok(
      inheritedLookupDiagnostics.some((item) =>
        item.message.includes('Unknown Django lookup operator `bog` in `created_at__bog`')
      ),
      `Expected inheritance-only lookup diagnostics to flag invalid inherited operators. Received: ${stringifyDiagnostics(inheritedLookupDiagnostics)}`
    );
    assert.ok(
      inheritedLookupDiagnostics.some((item) =>
        item.message.includes('Unknown Django lookup operator `bog` in `help_type__bog`')
      ),
      `Expected concrete/proxy inheritance lookup diagnostics to flag invalid inherited operators. Received: ${stringifyDiagnostics(inheritedLookupDiagnostics)}`
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

    assert.ok(
      filterMethodHoverText.includes('**filter**'),
      `Expected filter() hover to include the ORM member entry. Received: ${filterMethodHoverText}`
    );
    assert.ok(
      filterMethodHoverText.includes('Return model: `blog.QuestionThread`'),
      `Expected filter() hover to mention the related queryset model. Received: ${filterMethodHoverText}`
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
      'Expected queryset loop targets to keep related model member completion. ' +
        `Got: ${(querysetLoopCompletionList?.items ?? [])
          .map(completionItemLabel)
          .join(', ')}`
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
        diagnosticsEnabled: false,
        diagnosticsFullDocument: false,
        pylanceAutoApplyStubOverrides: false,
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
        diagnosticsEnabled: false,
        diagnosticsFullDocument: false,
        pylanceAutoApplyStubOverrides: false,
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
        diagnosticsEnabled: false,
        diagnosticsFullDocument: false,
        pylanceAutoApplyStubOverrides: false,
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
        diagnosticsEnabled: false,
        diagnosticsFullDocument: false,
        pylanceAutoApplyStubOverrides: false,
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
        diagnosticsEnabled: false,
        diagnosticsFullDocument: false,
        pylanceAutoApplyStubOverrides: false,
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
      diagnosticsEnabled: false,
      diagnosticsFullDocument: false,
      pylanceAutoApplyStubOverrides: false,
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
        diagnosticsEnabled: false,
        diagnosticsFullDocument: false,
        pylanceAutoApplyStubOverrides: false,
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

  test('writes Django stub overrides and reverts them via the override command', async function () {
    this.timeout(20_000);

    const tempWorkspace = fs.mkdtempSync(
      path.join(os.tmpdir(), 'django-orm-intellisense-stub-override-')
    );

    await removeWorkspaceFoldersFrom(0);
    await addWorkspaceFolder(tempWorkspace);

    const stubDirectory = path.join(
      tempWorkspace,
      '.vscode',
      'django-orm-intellisense-stubs'
    );
    const expectedStubPath = '.vscode/django-orm-intellisense-stubs';

    try {
      await vscode.commands.executeCommand(
        'djangoOrmIntellisense.configurePylanceDiagnostics',
        'recommended'
      );

      assert.ok(
        fs.existsSync(stubDirectory),
        `Expected stub override directory at ${stubDirectory}.`
      );
      const pyTypedPath = path.join(stubDirectory, 'django', 'py.typed');
      assert.ok(
        fs.existsSync(pyTypedPath),
        'Expected django/py.typed partial marker.'
      );
      assert.strictEqual(
        fs.readFileSync(pyTypedPath, 'utf8').trim(),
        'partial',
        'Expected py.typed to declare PEP 561 partial stubs.'
      );
      for (const relative of [
        'django/db/models/manager.pyi',
        'django/db/models/query.pyi',
        'django/db/models/base.pyi',
        'django/db/models/__init__.pyi',
      ]) {
        assert.ok(
          fs.existsSync(path.join(stubDirectory, relative)),
          `Expected shim file ${relative} to be written.`
        );
      }

      const managerStub = fs.readFileSync(
        path.join(stubDirectory, 'django', 'db', 'models', 'manager.pyi'),
        'utf8'
      );
      assert.ok(
        /def filter\(self, \*args: Any, \*\*kwargs: Any\)/.test(managerStub),
        'Expected Manager.filter override to accept arbitrary keyword lookups.'
      );

      const writtenSettings = readWorkspaceSettings(tempWorkspace);
      assert.strictEqual(
        writtenSettings['python.analysis.stubPath'],
        expectedStubPath,
        'Expected python.analysis.stubPath to point at the override directory.'
      );
      assert.strictEqual(
        writtenSettings['basedpyright.analysis.stubPath'],
        expectedStubPath,
        'Expected basedpyright.analysis.stubPath to point at the override directory.'
      );

      await vscode.commands.executeCommand(
        'djangoOrmIntellisense.configurePylanceDiagnostics',
        'restore'
      );

      assert.ok(
        !fs.existsSync(stubDirectory),
        'Expected override directory to be removed on restore.'
      );
      const restoredSettings = readWorkspaceSettings(tempWorkspace);
      assert.strictEqual(
        restoredSettings['python.analysis.stubPath'],
        undefined,
        'Expected python.analysis.stubPath to be cleared on restore.'
      );
      assert.strictEqual(
        restoredSettings['basedpyright.analysis.stubPath'],
        undefined,
        'Expected basedpyright.analysis.stubPath to be cleared on restore.'
      );
    } finally {
      await removeWorkspaceFoldersFrom(0);
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  test('preserves unrelated stubPath values during restore', async function () {
    this.timeout(20_000);

    const tempWorkspace = fs.mkdtempSync(
      path.join(os.tmpdir(), 'django-orm-intellisense-stub-override-keep-')
    );
    await removeWorkspaceFoldersFrom(0);
    await addWorkspaceFolder(tempWorkspace);

    try {
      const existingStubPath = './typings';
      writeWorkspaceSettings(tempWorkspace, {
        'python.analysis.stubPath': existingStubPath,
      });

      await vscode.commands.executeCommand(
        'djangoOrmIntellisense.configurePylanceDiagnostics',
        'recommended'
      );

      const afterApply = readWorkspaceSettings(tempWorkspace);
      assert.strictEqual(
        afterApply['python.analysis.stubPath'],
        '.vscode/django-orm-intellisense-stubs',
        'Expected command to take over stubPath while overrides are active.'
      );

      await vscode.commands.executeCommand(
        'djangoOrmIntellisense.configurePylanceDiagnostics',
        'restore'
      );

      const afterRestore = readWorkspaceSettings(tempWorkspace);
      assert.strictEqual(
        afterRestore['python.analysis.stubPath'],
        undefined,
        'Restore should clear the stubPath the extension set.'
      );
    } finally {
      await removeWorkspaceFoldersFrom(0);
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  test('Pylance resolves Manager.filter to our stub override, not site-packages or bundled stubs', async function () {
    this.timeout(90_000);

    const pylance = vscode.extensions.getExtension('ms-python.vscode-pylance');
    assert.ok(pylance?.isActive, 'Pylance must be active for this competition test.');

    const fixtureRoot = path.resolve(
      __dirname,
      '../../fixtures/minimal_project'
    );
    await setWorkspaceRoot(fixtureRoot);

    const activeWorkspace =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? fixtureRoot;
    const stubDirectory = path.join(
      activeWorkspace,
      '.vscode',
      'django-orm-intellisense-stubs'
    );
    const settingsSnapshot = readWorkspaceSettings(activeWorkspace);

    const environment = await ensureFixtureE2EEnvironment(fixtureRoot);
    assert.ok(
      environment,
      'Expected fixture E2E environment so Pylance has a Python interpreter to resolve Django imports.'
    );

    try {
      writeWorkspaceSettings(activeWorkspace, {
        ...settingsSnapshot,
        'python.defaultInterpreterPath': environment.interpreterPath,
        'python.analysis.extraPaths': [fixtureRoot],
      });
      await delay(500);

      await vscode.commands.executeCommand(
        'djangoOrmIntellisense.configurePylanceDiagnostics',
        'recommended'
      );

      assert.ok(
        fs.existsSync(path.join(stubDirectory, 'django', 'db', 'models', 'manager.pyi')),
        'Expected our manager.pyi shim to exist before Pylance resolution check.'
      );

      const document = await openFixtureDocument(
        fixtureRoot,
        'blog/query_examples.py'
      );

      const filterPosition = positionInsideText(
        document,
        "Post.objects.filter(author__profile__timezone='Asia/Seoul')",
        'filter'
      );

      const expectedStubFile = path
        .join(stubDirectory, 'django', 'db', 'models', 'manager.pyi')
        .toLowerCase();

      let definitions: (vscode.Location | vscode.LocationLink)[] = [];
      let winningPath: string | undefined;
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        definitions =
          (await vscode.commands.executeCommand<
            (vscode.Location | vscode.LocationLink)[]
          >('vscode.executeDefinitionProvider', document.uri, filterPosition)) ??
          [];

        winningPath = definitions
          .map((definition) => locationFilePath(definition).toLowerCase())
          .find((p) => p === expectedStubFile);

        if (winningPath) {
          break;
        }
        await delay(500);
      }

      assert.ok(
        winningPath,
        'Pylance should resolve Post.objects.filter to our stub override file. ' +
          `Received locations (none matched ${expectedStubFile}): ` +
          definitions
            .map((definition) => locationFilePath(definition))
            .join(', ')
      );

      const foreignStubs = definitions
        .map((definition) => locationFilePath(definition))
        .filter((p) => {
          const lower = p.toLowerCase();
          return (
            (lower.includes('site-packages') && lower.includes('django-stubs') ||
              lower.includes('ms-python.vscode-pylance') ||
              lower.includes('bundled/stubs/django-stubs')) &&
            lower !== expectedStubFile
          );
        });

      assert.strictEqual(
        foreignStubs.length,
        0,
        'No definition should land in installed or Pylance-bundled django-stubs. ' +
          `Leaked locations: ${foreignStubs.join(', ')}`
      );
    } finally {
      await vscode.commands.executeCommand(
        'djangoOrmIntellisense.configurePylanceDiagnostics',
        'restore'
      );
      writeWorkspaceSettings(activeWorkspace, settingsSnapshot);
      if (fs.existsSync(stubDirectory)) {
        fs.rmSync(stubDirectory, { recursive: true, force: true });
      }
    }
  });

  test('lookup operator completion still fires after stub overrides are applied', async function () {
    this.timeout(45_000);

    const fixtureRoot = path.resolve(
      __dirname,
      '../../fixtures/minimal_project'
    );
    await setWorkspaceRoot(fixtureRoot);

    const activeWorkspace =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? fixtureRoot;
    const stubDirectory = path.join(
      activeWorkspace,
      '.vscode',
      'django-orm-intellisense-stubs'
    );
    const settingsSnapshot = readWorkspaceSettings(activeWorkspace);

    const environment = await ensureFixtureE2EEnvironment(fixtureRoot);
    assert.ok(
      environment,
      'Expected fixture E2E environment for stub-override completion regression test.'
    );

    try {
      writeWorkspaceSettings(activeWorkspace, {
        ...settingsSnapshot,
        'python.defaultInterpreterPath': environment.interpreterPath,
      });
      await delay(500);

      await vscode.commands.executeCommand(
        'djangoOrmIntellisense.configurePylanceDiagnostics',
        'recommended'
      );

      const document = await openFixtureDocument(
        fixtureRoot,
        'blog/query_examples.py'
      );

      const position = positionAfterTextInContainer(
        document,
        "filter(author__='mentor')",
        'author__'
      );
      const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        position
      );

      const labels = (completions?.items ?? []).map((item) =>
        completionItemLabel(item)
      );

      assert.ok(
        hasCompletionItemLabel(completions?.items, 'exact'),
        `Lookup operator 'exact' should still complete after stub overrides are applied. Received labels: ${labels.slice(0, 15).join(', ')}`
      );
      assert.ok(
        hasCompletionItemLabel(completions?.items, 'in'),
        `Lookup operator 'in' should still complete after stub overrides are applied. Received labels: ${labels.slice(0, 15).join(', ')}`
      );
      assert.ok(
        hasCompletionItemLabel(completions?.items, 'profile'),
        `Related field 'profile' should still complete after stub overrides are applied. Received labels: ${labels.slice(0, 15).join(', ')}`
      );
    } finally {
      await vscode.commands.executeCommand(
        'djangoOrmIntellisense.configurePylanceDiagnostics',
        'restore'
      );
      writeWorkspaceSettings(activeWorkspace, settingsSnapshot);
      if (fs.existsSync(stubDirectory)) {
        fs.rmSync(stubDirectory, { recursive: true, force: true });
      }
    }
  });

  test('our ORM lookup hover still wins with stub overrides active', async function () {
    this.timeout(30_000);

    const fixtureRoot = path.resolve(
      __dirname,
      '../../fixtures/minimal_project'
    );
    await setWorkspaceRoot(fixtureRoot);

    const activeWorkspace =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? fixtureRoot;
    const stubDirectory = path.join(
      activeWorkspace,
      '.vscode',
      'django-orm-intellisense-stubs'
    );
    const settingsSnapshot = readWorkspaceSettings(activeWorkspace);

    try {
      await vscode.commands.executeCommand(
        'djangoOrmIntellisense.configurePylanceDiagnostics',
        'recommended'
      );

      assert.ok(
        fs.existsSync(stubDirectory),
        `Expected stub override directory to be created at ${stubDirectory}.`
      );

      const document = await openFixtureDocument(
        fixtureRoot,
        'blog/query_examples.py'
      );

      const hoverPosition = positionInsideText(
        document,
        'author__profile__timezone',
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
        `Expected our ORM lookup hover to still surface even after stub overrides were applied. Received: ${hoverText}`
      );
      assert.ok(
        hoverText.includes('Field kind: `CharField`'),
        `Expected our hover to still carry the field kind while stub overrides are active. Received: ${hoverText}`
      );
    } finally {
      await vscode.commands.executeCommand(
        'djangoOrmIntellisense.configurePylanceDiagnostics',
        'restore'
      );
      writeWorkspaceSettings(activeWorkspace, settingsSnapshot);
      if (fs.existsSync(stubDirectory)) {
        fs.rmSync(stubDirectory, { recursive: true, force: true });
      }
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
      'Expected chained snake_case fallback resolution to complete `content` through company → question_thread_set.get() → message_set.filter(). ' +
        `Got: ${(chainFilterCompletionList?.items ?? []).map(completionItemLabel).join(', ')}. ` +
        `Logs: ${getDiagnosticLogBufferForTesting()
          .filter((line) => line.includes('[completion:'))
          .slice(-12)
          .join(' | ')}`
    );
  });

  test('budget-exhausted diagnostics keep re-firing on the same document version', async function () {
    // Reproduces the bug observed in production logs: when diagnostics
    // exhausts its time budget, `lastDiagnosedDocumentVersions` is never
    // populated for that version, so any subsequent tracked-refresh
    // (e.g. from visible-editors-changed) re-fires a full scan even though
    // nothing has changed.
    this.timeout(60_000);
    // Force budget exhaustion: a sub-scan budget that even the smallest
    // valid-lookup phase will overflow, so we deterministically take the
    // budget-exhausted code path rather than completing cleanly.
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '5';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      clearDiagnosticLogBufferForTesting();

      const document = await openFixtureDocument(
        fixtureRoot,
        'blog/heavy_lookup_examples.py'
      );
      const expectedVersion = document.version;
      const fsPathSuffix = 'blog/heavy_lookup_examples.py';

      const matchesFireForDoc = (line: string): boolean =>
        line.startsWith('[diagnostics:trigger] fire ') && line.endsWith(fsPathSuffix);

      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        15_000
      );

      // Wait for the budget-exhausted line tied to this document so we know
      // diagnostics actually overflowed the (tight) budget rather than
      // completing cleanly.
      const matchesBudgetExhausted = (line: string): boolean =>
        line.startsWith('[diagnostics] time budget exhausted') &&
        line.endsWith(`/${fsPathSuffix}`);
      try {
        await waitForCondition(
          () => getDiagnosticLogBufferForTesting().some(matchesBudgetExhausted),
          20_000
        );
      } catch (err) {
        const interesting = getDiagnosticLogBufferForTesting()
          .filter((line) =>
            line.startsWith('[diagnostics:trigger]') ||
            line.startsWith('[diagnostics:phase]') ||
            line.startsWith('[diagnostics:scan]') ||
            line.startsWith('[diagnostics] '))
          .slice(-60);
        assert.fail(
          `Budget-exhausted log never seen. Recent diagnostics activity:\n` +
          interesting.join('\n')
        );
      }

      // After budget exhaustion, deliberately churn the visible editors so
      // `onDidChangeVisibleTextEditors` fires a tracked-refresh. In the buggy
      // state this re-fires `refreshDiagnostics` for the same version because
      // `lastDiagnosedDocumentVersions` was never populated by the partial run.
      const churnDoc = await openFixtureDocument(
        fixtureRoot,
        'blog/query_examples.py'
      );
      await delay(200);
      await vscode.window.showTextDocument(document);
      await delay(200);
      await vscode.window.showTextDocument(churnDoc);
      await delay(200);
      await vscode.window.showTextDocument(document);

      // Give the tracked-refresh debounce (500ms) plus a small budget run
      // enough time to schedule and fire again on the same version.
      await delay(2_500);

      const fireLines = getDiagnosticLogBufferForTesting().filter(matchesFireForDoc);
      const fireLinesForExpectedVersion = fireLines.filter((line) =>
        line.includes(` v=${expectedVersion} `)
      );
      const recentTriggerLines = getDiagnosticLogBufferForTesting()
        .filter((line) => line.startsWith('[diagnostics:trigger]'))
        .slice(-30);

      // Regression assertion: the same document at the same version must
      // not be re-scanned just because a previous scan exhausted its time
      // budget. Today this assertion FAILS — `lastDiagnosedDocumentVersions`
      // is only populated after a clean completion, so a tracked-refresh
      // from visible-editors-changed re-fires the full pipeline. Once that
      // is fixed (e.g. mark the version partial-but-handled at budget
      // exhaustion) this test should pass.
      assert.strictEqual(
        fireLinesForExpectedVersion.length,
        1,
        `Diagnostics re-fired ${fireLinesForExpectedVersion.length} times at v=${expectedVersion} ` +
        `after a budget-exhausted partial scan; expected exactly 1. ` +
        `This reproduces the production bug where partial-result documents ` +
        `keep being re-diagnosed on every tracked-refresh trigger.\n` +
        `Re-fires: ${fireLinesForExpectedVersion.join(' || ')}\n` +
        `Recent trigger lines: ${recentTriggerLines.join(' || ')}`
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
    }
  });

  test('receiver-resolution cache is reused across provider re-registration', async function () {
    // After fix #2, provider re-registration is deferred until an in-flight
    // scan ends. The re-registration then creates a fresh provider scope
    // which kicks off a second diagnostic cycle (Cycle 2) for the same
    // document version. Today Cycle 2 redoes all the receiver-resolution
    // work Cycle 1 already did, because the receiver cache lives inside
    // the provider closure and is destroyed on dispose.
    //
    // This test asserts the optimization: a module-level receiver cache
    // (keyed by docUri + version) should let Cycle 2 hit cached results
    // and emit phase2-lookups lines with substantially lower `requests=`
    // counts than Cycle 1.
    this.timeout(60_000);
    // Long enough budget that Cycle 1 reaches the full phase2-lookups
    // sweep instead of being cut short by the test budget.
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      // Earlier tests in this suite may have already populated the
      // cross-registration caches for this fixture. Clear them so Cycle 1
      // here starts cold, matching what we want to measure.
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      await openFixtureDocument(
        fixtureRoot,
        'blog/heavy_lookup_examples.py'
      );

      // Wait until Cycle 1 reaches in-flight.
      let cycle1Observed = false;
      const tStart = Date.now();
      while (Date.now() - tStart < 10_000) {
        if (getActiveDiagnosticScanRunningCountForTesting() >= 1) {
          cycle1Observed = true;
          break;
        }
        await delay(5);
      }
      assert.ok(cycle1Observed, 'Cycle 1 should reach in-flight state.');

      // Trigger a promotion; with the deferral fix it fires after Cycle 1.
      promotePythonProvidersForTesting('cache-reuse-test');

      // Wait for the deferred re-registration to fire AFTER Cycle 1 ends.
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some((line) =>
          line.includes('Re-registered Python providers (cache-reuse-test)')
        ),
        25_000
      );
      const buffer1 = getDiagnosticLogBufferForTesting();
      const reRegisterIdx = buffer1.findIndex((line) =>
        line.includes('Re-registered Python providers (cache-reuse-test)')
      );
      assert.ok(reRegisterIdx > 0, 'Re-register line must exist');

      // Wait for Cycle 2 (in the new provider scope) to also complete.
      await waitForCondition(
        () => {
          const buf = getDiagnosticLogBufferForTesting();
          // count fires after the re-register
          const firesAfter = buf.slice(reRegisterIdx).filter((l) =>
            l.startsWith('[diagnostics:trigger] fire ') &&
            l.endsWith('blog/heavy_lookup_examples.py')
          );
          if (firesAfter.length === 0) return false;
          // and a publish after that fire
          const publishAfter = buf.slice(reRegisterIdx).find((l) =>
            l.startsWith('[diagnostics:phase] publish')
          );
          return publishAfter != null;
        },
        25_000
      );

      // Parse phase2-lookups `requests=N` per cycle. Cycle 1 lines are
      // before reRegisterIdx; Cycle 2 lines are after.
      const buf = getDiagnosticLogBufferForTesting();
      const requestsRe = /\[diagnostics:phase\] phase2-lookups:[^ ]+ .*? requests=(\d+)/;
      const sumRequests = (lines: readonly string[]): number => {
        let sum = 0;
        for (const line of lines) {
          const m = requestsRe.exec(line);
          if (m) sum += Number(m[1]);
        }
        return sum;
      };
      const cycle1Lines = buf.slice(0, reRegisterIdx);
      const cycle2Lines = buf.slice(reRegisterIdx);
      const cycle1Requests = sumRequests(cycle1Lines);
      const cycle2Requests = sumRequests(cycle2Lines);

      assert.ok(
        cycle1Requests > 0,
        `Cycle 1 must perform some receiver resolution work. Got requests=${cycle1Requests}`
      );

      // Without the cross-registration cache, cycle2Requests is ~ cycle1Requests
      // (Cycle 2 redoes everything). With the cache, cycle2Requests should be
      // much smaller — at most 30% of Cycle 1.
      const ratio = cycle2Requests / cycle1Requests;
      assert.ok(
        ratio < 0.3,
        `Expected Cycle 2 receiver work to be cached across re-registration ` +
        `(ratio < 0.3). Got cycle1=${cycle1Requests} cycle2=${cycle2Requests} ratio=${ratio.toFixed(2)}\n` +
        `Cycle 1 phase2-lookups lines:\n  ${cycle1Lines.filter((l) => l.includes('phase2-lookups:')).join('\n  ')}\n` +
        `Cycle 2 phase2-lookups lines:\n  ${cycle2Lines.filter((l) => l.includes('phase2-lookups:')).join('\n  ')}\n` +
        `Receivers-visible lines:\n  ${buf.filter((l) => l.includes('receivers-visible')).join('\n  ')}`
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
    }
  });

  test('phase2-scan results are cached across provider re-registration', async function () {
    // Production captain trace showed phase2-scan running 1–2.5s per range
    // every cycle. The scan output (lookup/relation contexts) is a pure
    // function of (document text, range), so when a provider re-registration
    // kicks off a fresh diagnostic cycle on the SAME document version, the
    // regex-scan should be reused instead of redone.
    //
    // This test mirrors the receiver-resolution-cache test: open a fixture,
    // wait for Cycle 1 to complete (populating the cross-registration scan
    // cache), trigger a promotion, wait for Cycle 2 (same version), and
    // assert at least one phase2-scan emits `cache=hit`.
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      // heavy_lookup_examples.py is 800+ lines, well past the
      // VISIBLE_RANGE_SCAN_THRESHOLD so phase2-scan ranges are populated.
      await openFixtureDocument(
        fixtureRoot,
        'blog/heavy_lookup_examples.py'
      );

      let cycle1Observed = false;
      const tStart = Date.now();
      while (Date.now() - tStart < 10_000) {
        if (getActiveDiagnosticScanRunningCountForTesting() >= 1) {
          cycle1Observed = true;
          break;
        }
        await delay(5);
      }
      assert.ok(cycle1Observed, 'Cycle 1 should reach in-flight state.');

      promotePythonProvidersForTesting('scan-cache-test');

      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some((line) =>
          line.includes('Re-registered Python providers (scan-cache-test)')
        ),
        25_000
      );
      const bufBeforeCycle2 = getDiagnosticLogBufferForTesting();
      const reRegisterIdx = bufBeforeCycle2.findIndex((line) =>
        line.includes('Re-registered Python providers (scan-cache-test)')
      );
      assert.ok(reRegisterIdx > 0, 'Re-register line must exist');

      // Wait for Cycle 2 (in the new provider scope) to publish.
      await waitForCondition(
        () => {
          const buf = getDiagnosticLogBufferForTesting();
          const tail = buf.slice(reRegisterIdx);
          const firesAfter = tail.filter((l) =>
            l.startsWith('[diagnostics:trigger] fire ') &&
            l.endsWith('blog/heavy_lookup_examples.py')
          );
          if (firesAfter.length === 0) return false;
          return tail.some((l) => l.startsWith('[diagnostics:phase] publish'));
        },
        25_000
      );

      const buf = getDiagnosticLogBufferForTesting();
      const cycle1Lines = buf.slice(0, reRegisterIdx);
      const cycle2Lines = buf.slice(reRegisterIdx);

      // Cycle 1: every phase2-scan should miss (cold cache).
      const cycle1Phase2Scans = cycle1Lines.filter((l) =>
        l.includes('[diagnostics:phase] phase2-scan:')
      );
      assert.ok(
        cycle1Phase2Scans.length > 0,
        `Cycle 1 must emit phase2-scan lines. None observed.\n` +
        `Recent phase lines:\n  ${buf
          .filter((l) => l.includes('[diagnostics:phase]'))
          .slice(-20)
          .join('\n  ')}`
      );
      for (const line of cycle1Phase2Scans) {
        assert.ok(
          line.includes('cache=miss'),
          `Cycle 1 phase2-scan must be a cache miss (cold start). Got: ${line}`
        );
      }

      // Cycle 2: every phase2-scan should hit because (docUri, version, range)
      // matches what Cycle 1 cached.
      const cycle2Phase2Scans = cycle2Lines.filter((l) =>
        l.includes('[diagnostics:phase] phase2-scan:')
      );
      assert.ok(
        cycle2Phase2Scans.length > 0,
        `Cycle 2 must emit phase2-scan lines after re-registration.\n` +
        `Cycle 2 phase lines:\n  ${cycle2Lines
          .filter((l) => l.includes('[diagnostics:phase]'))
          .join('\n  ')}`
      );
      const cycle2Hits = cycle2Phase2Scans.filter((l) => l.includes('cache=hit'));
      assert.ok(
        cycle2Hits.length === cycle2Phase2Scans.length,
        `Cycle 2 phase2-scan must all be cache hits (same docUri + version + ` +
        `range as Cycle 1). Got ${cycle2Hits.length}/${cycle2Phase2Scans.length} hits.\n` +
        `Cycle 2 phase2-scan lines:\n  ${cycle2Phase2Scans.join('\n  ')}`
      );

      // Cycle 2 phase2-scan wall time should be much smaller than Cycle 1
      // since scanning is skipped entirely. Sanity check: each line emits a
      // duration like `phase2-scan:0-100 1063ms`. Cycle 2 should be < 50ms.
      const phaseMsRe = /\[diagnostics:phase\] phase2-scan:[^ ]+ (\d+)ms/;
      const cycle2MaxMs = cycle2Phase2Scans.reduce((max, line) => {
        const m = phaseMsRe.exec(line);
        return m ? Math.max(max, Number(m[1])) : max;
      }, 0);
      assert.ok(
        cycle2MaxMs < 50,
        `Cycle 2 phase2-scan with cache hit must complete near-instantly. ` +
        `Got max=${cycle2MaxMs}ms.\n` +
        `Cycle 2 phase2-scan lines:\n  ${cycle2Phase2Scans.join('\n  ')}`
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
    }
  });

  test('scan cache survives daemon-state cache clear (production captain regression)', async function () {
    // Captain trace showed scan cache=miss in Cycle 2 even after the
    // cross-registration cache was wired in. Root cause: when daemon
    // transitions to `ready`, `onDidChangeState` calls
    // `clearLookupResolutionAndReceiverCachesAcrossRegistrations()` which
    // (prior to this fix) also cleared the scan cache. But scan results
    // are pure functions of (document text, range) — they don't depend on
    // daemon model graph state. Clearing them on every daemon-state ready
    // transition defeats the cross-registration cache entirely in
    // production, since the daemon-state ready event always precedes the
    // first re-registration after startup.
    //
    // The fix is to NOT clear the scan cache from
    // `clearLookupResolutionAndReceiverCachesAcrossRegistrations`. This
    // test simulates the production sequence:
    //   1. Cycle 1 runs, scan cache populated.
    //   2. daemon transitions to ready → cache clear is called.
    //   3. Provider re-registration fires → Cycle 2 same version.
    //   4. Cycle 2 phase2-scan should hit cache despite the daemon-state
    //      clear in step 2.
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      await openFixtureDocument(
        fixtureRoot,
        'blog/heavy_lookup_examples.py'
      );

      // Wait for Cycle 1 to complete fully (publish in log buffer).
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(
          (l) => l.startsWith('[diagnostics:phase] publish')
        ),
        25_000
      );

      // Snapshot Cycle 1's phase2-scan lines for the assertion later.
      const bufAfterCycle1 = getDiagnosticLogBufferForTesting();
      const cycle1Phase2 = bufAfterCycle1.filter((l) =>
        l.includes('[diagnostics:phase] phase2-scan:')
      );
      assert.ok(
        cycle1Phase2.length > 0,
        `Cycle 1 must emit phase2-scan lines. Got 0.\n` +
        `Recent phase lines:\n  ${bufAfterCycle1
          .filter((l) => l.includes('[diagnostics:phase]'))
          .slice(-15)
          .join('\n  ')}`
      );
      const cycle1End = bufAfterCycle1.length;

      // Step 2: simulate daemon-state ready clear (this is what previously
      // wiped the scan cache).
      simulateDaemonReadyCacheClearForTesting();

      // Step 3: trigger re-registration via promotion.
      promotePythonProvidersForTesting('daemon-state-scan-cache-test');

      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some((line) =>
          line.includes('Re-registered Python providers (daemon-state-scan-cache-test)')
        ),
        25_000
      );

      // Wait for Cycle 2 to publish in the new provider scope.
      await waitForCondition(
        () => {
          const buf = getDiagnosticLogBufferForTesting();
          const tail = buf.slice(cycle1End);
          return tail.some((l) =>
            l.includes('Re-registered Python providers (daemon-state-scan-cache-test)')
          ) && tail.some((l) =>
            l.startsWith('[diagnostics:phase] publish')
          );
        },
        25_000
      );

      // Step 4: assert Cycle 2 phase2-scan hits cache.
      const buf = getDiagnosticLogBufferForTesting();
      const cycle2Tail = buf.slice(cycle1End);
      const cycle2Phase2 = cycle2Tail.filter((l) =>
        l.includes('[diagnostics:phase] phase2-scan:')
      );
      assert.ok(
        cycle2Phase2.length > 0,
        `Cycle 2 must emit phase2-scan lines after re-registration.\n` +
        `Cycle 2 phase lines:\n  ${cycle2Tail
          .filter((l) => l.includes('[diagnostics:phase]'))
          .join('\n  ')}`
      );
      const cycle2Hits = cycle2Phase2.filter((l) => l.includes('cache=hit'));
      assert.ok(
        cycle2Hits.length === cycle2Phase2.length,
        `After daemon-state clear, Cycle 2 phase2-scan MUST still hit cache ` +
        `because scan results don't depend on daemon model graph. ` +
        `Got ${cycle2Hits.length}/${cycle2Phase2.length} hits.\n` +
        `Cycle 2 phase2-scan lines:\n  ${cycle2Phase2.join('\n  ')}`
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
    }
  });

  test('provider promotion defers while a diagnostic scan is in flight', async function () {
    // Reproduces the production-observed pattern where Re-registered Python
    // providers (daemon-ready) fires mid-scan and disposes the in-flight
    // refreshDiagnostics, wasting ~700ms of validate/scan work. With the
    // deferral fix the promotion logs a "Deferred ..." line, the scan still
    // reaches its publish/budget log, and the promotion fires AFTER the scan
    // completes.
    this.timeout(60_000);
    // Long enough for the scan to be observably in flight, short enough to
    // keep the test under a few seconds.
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '500';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      // Any setup/restart-triggered scans may still be in flight; wait for
      // a quiet moment before opening the heavy fixture so the in-flight
      // observation later is unambiguous.
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearDiagnosticLogBufferForTesting();

      await openFixtureDocument(
        fixtureRoot,
        'blog/heavy_lookup_examples.py'
      );

      // Tight-poll until the scan is actually running. waitForCondition's
      // 200ms cadence can miss the in-flight window on small files, so we
      // poll every 5ms.
      let inFlightObserved = false;
      const inFlightWaitStart = Date.now();
      while (Date.now() - inFlightWaitStart < 10_000) {
        if (getActiveDiagnosticScanRunningCountForTesting() >= 1) {
          inFlightObserved = true;
          break;
        }
        await delay(5);
      }
      assert.ok(
        inFlightObserved,
        'Diagnostic scan should reach the in-flight state for the heavy fixture.'
      );

      // Trigger a promotion mid-scan. The deferral logic should log a
      // "Deferred Python provider promotion" line instead of disposing the
      // in-flight scan.
      const countWhenPromoting = getActiveDiagnosticScanRunningCountForTesting();
      promotePythonProvidersForTesting('test-mid-scan-promotion');

      try {
        await waitForCondition(
          () => getDiagnosticLogBufferForTesting().some((line) =>
            line.includes('Deferred Python provider promotion (test-mid-scan-promotion)')
          ),
          5_000
        );
      } catch (err) {
        const lines = getDiagnosticLogBufferForTesting()
          .filter((l) =>
            l.includes('Re-registered') ||
            l.includes('Deferred') ||
            l.includes('[diagnostics:trigger]') ||
            l.includes('[diagnostics:phase] publish') ||
            l.includes('time budget exhausted')
          )
          .slice(-50);
        assert.fail(
          `Deferral log not seen. countWhenPromoting=${countWhenPromoting} ` +
          `countNow=${getActiveDiagnosticScanRunningCountForTesting()}\n` +
          lines.join('\n')
        );
      }

      // The scan should still complete (counter returns to zero).
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        20_000
      );

      // After the scan ends, the deferred promotion should actually fire.
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some((line) =>
          line.includes('Re-registered Python providers (test-mid-scan-promotion)')
        ),
        5_000
      );

      // Sanity: the re-registration log line must appear AFTER the deferral
      // log line — otherwise we'd be re-registering before the scan ended.
      const buffer = getDiagnosticLogBufferForTesting();
      const deferIdx = buffer.findIndex((line) =>
        line.includes('Deferred Python provider promotion (test-mid-scan-promotion)')
      );
      const reRegisterIdx = buffer.findIndex((line) =>
        line.includes('Re-registered Python providers (test-mid-scan-promotion)')
      );
      assert.ok(
        deferIdx >= 0 && reRegisterIdx > deferIdx,
        `Expected deferral to log before re-registration. defer=${deferIdx} reRegister=${reRegisterIdx}\n` +
        `Buffer: ${buffer.slice(-30).join('\n')}`
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
    }
  });

  test('resolveLookupPath skips Python IPC for diagnostic-background when native is confident and runtime is not ready', async function () {
    // Production trace showed `[IPC] resolveLookupPath(source=diagnostic, ...
    // db.ShareClass / defaults / get_or_create): 1420ms` while the daemon
    // itself completed the call in 1ms. The 1.4s gap is pure IPC overhead
    // under event-loop pressure. When the daemon's Django runtime is NOT
    // bootstrapped, Python uses the same default lookup-operator set Rust
    // already evaluated — so Python's answer is guaranteed to match native.
    // We can skip the IPC entirely.
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    process.env.DJLS_TEST_FORCE_RUNTIME_NOT_READY = '1';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      // Fixture with ~105 invalid lookups whose first segment doesn't
      // exist on Post. Native returns `resolved: false`; without the fix
      // each one round-trips to Python.
      await openFixtureDocument(
        fixtureRoot,
        'blog/invalid_lookup_examples.py'
      );

      // Wait for the scan to fire and publish.
      const matchesFireForDoc = (line: string): boolean =>
        line.startsWith('[diagnostics:trigger] fire ') &&
        line.endsWith('blog/invalid_lookup_examples.py');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        15_000
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        20_000
      );

      // Inspect the captured IPC log. We must not have made any
      // resolveLookupPath IPC calls from the diagnostic source.
      const buf = getDiagnosticLogBufferForTesting();
      const slowDiagnosticIpcs = buf.filter((line) =>
        line.includes('[IPC] resolveLookupPath') &&
        line.includes('source=diagnostic')
      );

      assert.strictEqual(
        slowDiagnosticIpcs.length,
        0,
        `Expected no diagnostic-background resolveLookupPath IPC calls when ` +
        `native is confident and runtime is not ready. Found ${slowDiagnosticIpcs.length}:\n` +
        slowDiagnosticIpcs.slice(0, 10).join('\n')
      );

      // Sanity: confirm the scan actually processed lookups (otherwise the
      // test could trivially pass on an empty scan).
      const validateLines = buf.filter((l) =>
        l.includes('[diagnostics:phase] validate-lookups-visible')
      );
      const sawValidWork = validateLines.some((line) => {
        const m = /valid=(\d+)/.exec(line);
        return m != null && Number(m[1]) > 0;
      });
      assert.ok(
        sawValidWork,
        `Expected at least one validate-lookups phase with valid>0 ` +
        `(otherwise the IPC skip is trivial). Got:\n${validateLines.join('\n')}`
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
      delete process.env.DJLS_TEST_FORCE_RUNTIME_NOT_READY;
    }
  });

  test('receiver expressions starting with Python keywords resolve correctly', async function () {
    // Production trace from captain workspace showed phase2-lookups
    // `noRecvSamples=["notCompanyNameChangeModel.objects", ...]`. The real
    // source is `if not CompanyNameChangeModel.objects.filter(...).exists()`,
    // but `compactPythonExpression` stripped ALL whitespace and concatenated
    // `not` + the model name, turning the receiver into an unresolvable
    // pseudo-identifier. This test exercises a fixture full of
    // `if not Post.objects.filter(...)` / `assert not Post.objects ...`
    // patterns and asserts the receiver resolver finds them.
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      await openFixtureDocument(
        fixtureRoot,
        'blog/keyword_prefix_lookup_examples.py'
      );

      const matchesFireForDoc = (line: string): boolean =>
        line.startsWith('[diagnostics:trigger] fire ') &&
        line.endsWith('blog/keyword_prefix_lookup_examples.py');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        15_000
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        20_000
      );

      // Aggregate exit counters across all phase2-lookups lines emitted
      // during this scan plus the visible-range receivers stats.
      const buf = getDiagnosticLogBufferForTesting();
      let totalValid = 0;
      let totalNoRecv = 0;
      const noRecvSampleSnippets: string[] = [];
      const phase2Re = /\[diagnostics:phase\] phase2-lookups:[^ ]+ .*? valid=(\d+) added=\d+ exit=cancelled:\d+,noRecv:(\d+).*?(?: noRecvSamples=\[([^\]]*)\])?$/;
      const visibleReceiversRe = /\[diagnostics:phase\] receivers-visible .*? validated=(\d+) pending=(\d+) batchItems=\d+ receivers=\d+ missing=(\d+) virtual=\d+/;
      for (const line of buf) {
        const m = phase2Re.exec(line);
        if (m) {
          totalValid += Number(m[1]);
          totalNoRecv += Number(m[2]);
          if (m[3]) noRecvSampleSnippets.push(m[3]);
          continue;
        }
        const r = visibleReceiversRe.exec(line);
        if (r) {
          totalValid += Number(r[1]);
          totalNoRecv += Number(r[3]);
        }
      }

      assert.ok(
        totalValid >= 10,
        `Expected the fixture's keyword-prefix lookups to validate (>= 10). ` +
        `Got totalValid=${totalValid}. phase2-lookups lines:\n  ` +
        buf.filter((l) => l.includes('phase2-lookups:')).join('\n  ')
      );

      assert.strictEqual(
        totalNoRecv,
        0,
        `Expected zero noRecv exits for receivers like 'not Post.objects.filter(...)'. ` +
        `Got totalNoRecv=${totalNoRecv} out of valid=${totalValid}. ` +
        `noRecvSamples: ${noRecvSampleSnippets.join(' | ')}\n` +
        `phase2-lookups lines:\n  ` +
        buf.filter((l) => l.includes('phase2-lookups:')).join('\n  ')
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
    }
  });

  test('reverse-manager accessors resolve across inheritance and cross-app patterns', async function () {
    // Production trace from captain workspace captured
    // `shareholders_meeting.director_attendance_set` as noRecv even though
    // `ShareholdersMeeting` is in modelLabelByName. The reverse accessor
    // (named via `related_name`) was missing from the parent model's
    // surface entry — most likely because the FK lives on an abstract
    // base or in a cross-app module whose enumeration path has gaps.
    //
    // This test exercises a realistic mix of reverse patterns:
    //   - same-app FK reverse (Author.posts)
    //   - cross-app + inherited FK reverse (Author.vendors via
    //     org/models/base.py's abstract VendorBase.created_by)
    //   - self-referential FK reverse (Author.mentees)
    //   - OneToOne reverse (Author.profile)
    //   - M2M reverse (Tag.posts)
    //
    // All receivers must resolve; any noRecv flags a daemon-side
    // reverse-enumeration gap mirroring captain's pattern.
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      await openFixtureDocument(
        fixtureRoot,
        'blog/reverse_manager_lookup_examples.py'
      );

      const matchesFireForDoc = (line: string): boolean =>
        line.startsWith('[diagnostics:trigger] fire ') &&
        line.endsWith('blog/reverse_manager_lookup_examples.py');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        15_000
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        20_000
      );

      const buf = getDiagnosticLogBufferForTesting();
      let totalValid = 0;
      let totalNoRecv = 0;
      const sampleSnippets: string[] = [];
      const phase2Re = /\[diagnostics:phase\] phase2-lookups:[^ ]+ .*? valid=(\d+) added=\d+ exit=cancelled:\d+,noRecv:(\d+).*?(?: noRecvSamples=\[([^\]]*)\])?$/;
      const visRecRe = /\[diagnostics:phase\] receivers-visible .*? validated=(\d+) pending=\d+ batchItems=\d+ receivers=\d+ missing=(\d+) virtual=\d+(?:[^[]*noRecvSamples=\[([^\]]*)\])?/;
      for (const line of buf) {
        const m = phase2Re.exec(line);
        if (m) {
          totalValid += Number(m[1]);
          totalNoRecv += Number(m[2]);
          if (m[3]) sampleSnippets.push(m[3]);
          continue;
        }
        const r = visRecRe.exec(line);
        if (r) {
          totalValid += Number(r[1]);
          totalNoRecv += Number(r[2]);
          if (r[3]) sampleSnippets.push(r[3]);
        }
      }

      assert.ok(
        totalValid >= 10,
        `Expected reverse-manager lookups to validate (>= 10). Got ${totalValid}.`
      );
      assert.strictEqual(
        totalNoRecv,
        0,
        `Expected zero noRecv for reverse-manager patterns. Any noRecv here ` +
        `means the daemon failed to enumerate that reverse accessor on the ` +
        `parent model's surface entry. ` +
        `Got totalNoRecv=${totalNoRecv}/${totalValid}. ` +
        `Samples: ${sampleSnippets.join(' | ')}\n` +
        `phase2-lookups lines:\n  ` +
        buf.filter((l) => l.includes('phase2-lookups:')).join('\n  ') + '\n' +
        `receivers-visible lines:\n  ` +
        buf.filter((l) => l.includes('receivers-visible')).join('\n  ')
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
    }
  });

  test('phase2-lookups caps wall time per context to avoid budget monopoly', async function () {
    // Production trace from captain workspace showed phase2-lookups
    // spending 6.8s on 12 valid contexts (~566ms each) because 2 BG IPC
    // calls were stuck. With concurrency=4, a few slow contexts can
    // monopolise the whole 10s diagnostic budget, leaving the rest of
    // the file unprocessed.
    //
    // The per-context Promise.race timeout caps each context's wall time
    // so slow daemon round-trips count as `timeout:N` exit instead of
    // blocking the queue. The next cycle benefits because the underlying
    // Promise still resolves into the response cache.
    //
    // This test injects a 2.5s delay into resolveOrmMember BG IPC so the
    // timeout (default 1500ms) fires reliably, then asserts:
    //   1. `timeout:N` exit counter is > 0
    //   2. phase2-lookups wall time stays well under the diagnostic budget
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '10000';
    process.env.DJLS_DIAGNOSTIC_PER_CONTEXT_TIMEOUT_MS = '300';
    process.env.DJLS_TEST_RESOLVE_LOOKUP_PATH_DELAY_MS = '2500';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      // Invalid lookups force the daemon's resolveLookupPath BG IPC to
      // fire (native says unresolved; BG is consulted as a fallback).
      // The fixture spans 600+ lines so most lookups fall into the
      // phase2-lookups ranges (outside the visible-first window), which
      // is where the per-context timeout machinery lives. With injected
      // 2500ms delay and 300ms per-context cap, the race should time out
      // and increment the `timeout:` exit counter.
      await openFixtureDocument(
        fixtureRoot,
        'blog/heavy_invalid_lookup_examples.py'
      );

      const matchesFireForDoc = (line: string): boolean =>
        line.startsWith('[diagnostics:trigger] fire ') &&
        line.endsWith('blog/heavy_invalid_lookup_examples.py');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        15_000
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        25_000
      );

      // Find phase2-lookups lines and validate their wall time is bounded.
      const buf = getDiagnosticLogBufferForTesting();
      const phase2Lines = buf.filter((l) =>
        l.includes('[diagnostics:phase] phase2-lookups:')
      );
      assert.ok(
        phase2Lines.length > 0,
        `Expected at least one phase2-lookups line; fixture may have been ` +
        `entirely within visible-first range.\n` +
        `Recent diagnostic lines:\n  ${buf
          .filter((l) => l.includes('[diagnostics:phase]'))
          .slice(-20)
          .join('\n  ')}`
      );

      const timeoutRe = /timeout:(\d+)/;
      const phaseMsRe = /\[diagnostics:phase\] phase2-lookups:[^ ]+ (\d+)ms/;
      let maxPhaseMs = 0;
      let totalTimeouts = 0;
      for (const line of phase2Lines) {
        const tMatch = timeoutRe.exec(line);
        if (tMatch) totalTimeouts += Number(tMatch[1]);
        const pMatch = phaseMsRe.exec(line);
        if (pMatch) maxPhaseMs = Math.max(maxPhaseMs, Number(pMatch[1]));
      }

      assert.ok(
        totalTimeouts > 0,
        `Expected per-context timeout to fire at least once with a 2500ms ` +
        `injected daemon delay and 300ms per-context cap. ` +
        `Got totalTimeouts=${totalTimeouts}. ` +
        `phase2-lookups lines:\n  ${phase2Lines.join('\n  ')}`
      );

      // Throughput sanity check: without the per-context cap, each slow
      // IPC (2500ms) holds 1 concurrency slot. With concurrency=4 and a
      // 10s diagnostic budget, only ~16 contexts (4 slots × 4 batches)
      // could complete before budget exhaustion. The per-context cap
      // (300ms) lets each slot recycle ~33x faster, so we expect orders
      // of magnitude more contexts processed within the same budget.
      assert.ok(
        totalTimeouts >= 32,
        `Expected per-context cap to dramatically increase throughput by ` +
        `freeing concurrency slots from slow IPCs. Got totalTimeouts=${totalTimeouts} ` +
        `(without cap this would be ~16 max with 4-way concurrency and 2.5s IPC). ` +
        `phase2-lookups lines:\n  ${phase2Lines.join('\n  ')}`
      );
      // Silence unused: maxPhaseMs is informational (budget-bounded).
      void maxPhaseMs;
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
      delete process.env.DJLS_DIAGNOSTIC_PER_CONTEXT_TIMEOUT_MS;
      delete process.env.DJLS_TEST_RESOLVE_LOOKUP_PATH_DELAY_MS;
    }
  });

  test('X.objects receiver synthesizes manager when Python daemon cannot resolve', async function () {
    // Reproduces the captain workspace pattern: a workspace model is in
    // `daemon.modelLabelByName` (via surfaceIndex or staticFallback) but its
    // surface entry lacks a `model_class -> objects` mapping. Python BG IPC
    // would normally fill the gap, but on captain Django isn't installed so
    // the daemon returns `{resolved: false}` and the diagnostic landed in
    // noRecv. The client-side shortcut now synthesizes a manager receiver
    // for `<known_model>.objects` so the lookup path is still validated.
    //
    // `DJLS_TEST_FORCE_ORM_MEMBER_UNRESOLVED=1` simulates the Python-cannot-
    // -help state inside minimal_project (which has Django available).
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    process.env.DJLS_TEST_FORCE_ORM_MEMBER_UNRESOLVED = '1';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      // Use the existing built-in fixture — User/Group/Permission live in
      // staticFallback only, so without Python BG help every `.objects`
      // call would previously land in noRecv (root_matched). The new
      // client-side fallback must catch them.
      await openFixtureDocument(
        fixtureRoot,
        'blog/builtin_model_lookup_examples.py'
      );

      const matchesFireForDoc = (line: string): boolean =>
        line.startsWith('[diagnostics:trigger] fire ') &&
        line.endsWith('blog/builtin_model_lookup_examples.py');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        15_000
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        20_000
      );

      const buf = getDiagnosticLogBufferForTesting();
      let totalValid = 0;
      let totalNoRecv = 0;
      const sampleSnippets: string[] = [];
      const phase2Re = /\[diagnostics:phase\] phase2-lookups:[^ ]+ .*? valid=(\d+) added=\d+ exit=cancelled:\d+,noRecv:(\d+).*?(?: noRecvSamples=\[([^\]]*)\])?$/;
      const visRecRe = /\[diagnostics:phase\] receivers-visible .*? validated=(\d+) pending=\d+ batchItems=\d+ receivers=\d+ missing=(\d+) virtual=\d+/;
      for (const line of buf) {
        const m = phase2Re.exec(line);
        if (m) {
          totalValid += Number(m[1]);
          totalNoRecv += Number(m[2]);
          if (m[3]) sampleSnippets.push(m[3]);
          continue;
        }
        const r = visRecRe.exec(line);
        if (r) {
          totalValid += Number(r[1]);
          totalNoRecv += Number(r[2]);
        }
      }

      assert.ok(
        totalValid >= 10,
        `Expected built-in lookups to validate (>= 10). Got totalValid=${totalValid}.`
      );
      assert.strictEqual(
        totalNoRecv,
        0,
        `Expected zero noRecv for 'User.objects' / 'Group.objects' / etc. ` +
        `when Python daemon cannot help. The client-side <model_class>.objects ` +
        `fallback must synthesize a manager receiver. ` +
        `Got totalNoRecv=${totalNoRecv}/${totalValid}. ` +
        `Samples: ${sampleSnippets.join(' | ')}\n` +
        `phase2-lookups lines:\n  ` +
        buf.filter((l) => l.includes('phase2-lookups:')).join('\n  ') + '\n' +
        `receivers-visible lines:\n  ` +
        buf.filter((l) => l.includes('receivers-visible')).join('\n  ')
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
      delete process.env.DJLS_TEST_FORCE_ORM_MEMBER_UNRESOLVED;
    }
  });

  test('<KnownModel>.objects synthesizes manager even when symbol resolution fails (race recovery)', async function () {
    // Captain trace L122 showed `FileAttachment.objects#root_matched:FileAttachment`
    // — the classifier later confirmed `FileAttachment` was in modelLabelByName
    // (root_matched), but receiver resolution returned undefined. Root cause:
    // race between phase2-lookups resolution and surface index hydration.
    // When `resolveModelLabelFromSymbol` is called during a daemon-busy
    // window, both the local lookup AND the BG IPC fall back to unresolved.
    // The recursive `objectReceiver` ends up undefined, the previously
    // working `<model_class>.objects` shortcut (which requires
    // objectReceiver.kind === 'model_class') never fires, and the lookup
    // lands in noRecv.
    //
    // The defensive sync fallback in resolveLookupReceiverAtOffset checks
    // daemon.modelLabelByName.get(objectExpression) directly when both
    // recursive resolutions returned undefined. Because modelLabelByName
    // gets populated by surface deltas while the cycle is in flight, the
    // fallback catches the race recovery window.
    //
    // To reproduce deterministically: force BOTH the symbol resolution
    // AND the resolveOrmMember IPC to return unresolved. The shortcut
    // requiring model_class objectReceiver never fires; only the new sync
    // fallback can synthesize the manager.
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    process.env.DJLS_TEST_FORCE_ORM_MEMBER_UNRESOLVED = '1';
    process.env.DJLS_TEST_FORCE_RESOLVE_MODEL_LABEL_NULL = '1';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      // builtin_model_lookup_examples.py uses User.objects / Group.objects
      // patterns where User/Group are in modelLabelByName via the Django
      // built-in static fallback. With the symbol-resolution hook on, the
      // recursive `resolveModelLabelFromSymbol` returns undefined; only the
      // sync fallback can recover.
      await openFixtureDocument(
        fixtureRoot,
        'blog/builtin_model_lookup_examples.py'
      );

      const matchesFireForDoc = (line: string): boolean =>
        line.startsWith('[diagnostics:trigger] fire ') &&
        line.endsWith('blog/builtin_model_lookup_examples.py');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        15_000
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        20_000
      );

      const buf = getDiagnosticLogBufferForTesting();
      let totalValid = 0;
      let totalNoRecv = 0;
      const sampleSnippets: string[] = [];
      const phase2Re = /\[diagnostics:phase\] phase2-lookups:[^ ]+ .*? valid=(\d+) added=\d+ exit=cancelled:\d+,noRecv:(\d+).*?(?: noRecvSamples=\[([^\]]*)\])?$/;
      const visRecRe = /\[diagnostics:phase\] receivers-visible .*? validated=(\d+) pending=\d+ batchItems=\d+ receivers=\d+ missing=(\d+) virtual=\d+/;
      for (const line of buf) {
        const m = phase2Re.exec(line);
        if (m) {
          totalValid += Number(m[1]);
          totalNoRecv += Number(m[2]);
          if (m[3]) sampleSnippets.push(m[3]);
          continue;
        }
        const r = visRecRe.exec(line);
        if (r) {
          totalValid += Number(r[1]);
          totalNoRecv += Number(r[2]);
        }
      }

      assert.ok(
        totalValid >= 10,
        `Expected built-in lookups to validate (>= 10). Got totalValid=${totalValid}.`
      );
      assert.strictEqual(
        totalNoRecv,
        0,
        `With both symbol resolution and resolveOrmMember forced to unresolved, ` +
        `the sync <KnownModel>.objects fallback must still synthesize a manager ` +
        `receiver. Got totalNoRecv=${totalNoRecv}/${totalValid}. ` +
        `Samples: ${sampleSnippets.join(' | ')}\n` +
        `phase2-lookups lines:\n  ` +
        buf.filter((l) => l.includes('phase2-lookups:')).join('\n  ') + '\n' +
        `receivers-visible lines:\n  ` +
        buf.filter((l) => l.includes('receivers-visible')).join('\n  ')
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
      delete process.env.DJLS_TEST_FORCE_ORM_MEMBER_UNRESOLVED;
      delete process.env.DJLS_TEST_FORCE_RESOLVE_MODEL_LABEL_NULL;
    }
  });

  test('receiver resolves via localWorkspaceIndex when daemon.modelLabelByName drops the short name', async function () {
    // Captain trace L122/L177/L454/.../L713 (10× across cycles) showed
    // `CompanyQuestionThread.objects#unknown_root` even though the completion
    // path emitted `local:hit` for `zuzu.CompanyQuestionThread`. Root cause:
    // daemon.modelLabelByName (first-come-wins on short-name collisions) and
    // localWorkspaceIndex.modelLabelByName (last-come-wins) can disagree.
    // The captain workspace ended up with `CompanyQuestionThread` registered
    // in localWorkspaceIndex but absent from daemon.modelLabelByName,
    // leaving every cycle's receiver resolution permanently in noRecv.
    //
    // The fix is `findModelLabelByShortName` / `hasModelByShortName` which
    // consult BOTH maps. This test simulates the captain state by clearing
    // daemon.modelLabelByName after Cycle 1 and re-triggering — the next
    // cycle must still resolve `<KnownModel>.objects` patterns via the
    // localWorkspaceIndex fallback.
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      await openFixtureDocument(
        fixtureRoot,
        'blog/builtin_model_lookup_examples.py'
      );

      const matchesFireForDoc = (line: string): boolean =>
        line.startsWith('[diagnostics:trigger] fire ') &&
        line.endsWith('blog/builtin_model_lookup_examples.py');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        15_000
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        20_000
      );

      // Simulate captain trace: daemon.modelLabelByName loses the short name
      // entries (but localWorkspaceIndex retains them). After this, re-run
      // a diagnostic cycle by clearing receiver caches + bumping the file.
      const daemon = getActiveDaemonForTesting();
      assert.ok(daemon, 'daemon must be active');
      clearDaemonModelLabelByNameForTesting(daemon);
      assert.strictEqual(
        daemon.modelLabelByName.size, 0,
        'simulation should leave daemon.modelLabelByName empty'
      );
      assert.ok(
        daemon.localWorkspaceIndexForTesting.modelLabelByName.size > 0,
        'localWorkspaceIndex.modelLabelByName must still be populated'
      );

      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      // Trigger a fresh cycle by promoting (which causes a re-register +
      // refresh).
      promotePythonProvidersForTesting('localworkspace-fallback-test');

      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        20_000
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        20_000
      );

      // Assert built-in lookups still resolve via the localWorkspaceIndex
      // fallback. Without `findModelLabelByShortName`, every `User.objects`,
      // `Group.objects`, etc. would land in noRecv (unknown_root).
      const buf = getDiagnosticLogBufferForTesting();
      let totalValid = 0;
      let totalNoRecv = 0;
      const sampleSnippets: string[] = [];
      const phase2Re = /\[diagnostics:phase\] phase2-lookups:[^ ]+ .*? valid=(\d+) added=\d+ exit=cancelled:\d+,noRecv:(\d+).*?(?: noRecvSamples=\[([^\]]*)\])?$/;
      const visRecRe = /\[diagnostics:phase\] receivers-visible .*? validated=(\d+) pending=\d+ batchItems=\d+ receivers=\d+ missing=(\d+) virtual=\d+/;
      for (const line of buf) {
        const m = phase2Re.exec(line);
        if (m) {
          totalValid += Number(m[1]);
          totalNoRecv += Number(m[2]);
          if (m[3]) sampleSnippets.push(m[3]);
          continue;
        }
        const r = visRecRe.exec(line);
        if (r) {
          totalValid += Number(r[1]);
          totalNoRecv += Number(r[2]);
        }
      }

      assert.ok(
        totalValid >= 10,
        `Expected lookups to validate via localWorkspaceIndex fallback (>= 10). ` +
        `Got totalValid=${totalValid}.`
      );
      assert.strictEqual(
        totalNoRecv,
        0,
        `Diagnostic must use localWorkspaceIndex when daemon.modelLabelByName ` +
        `drops short names. Got totalNoRecv=${totalNoRecv}/${totalValid}. ` +
        `Samples: ${sampleSnippets.join(' | ')}\n` +
        `phase2-lookups lines:\n  ` +
        buf.filter((l) => l.includes('phase2-lookups:')).join('\n  ')
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
    }
  });

  test('realistic mixed workspace patterns resolve with minimal noRecv', async function () {
    // Comprehensive smoke test mirroring real-world shapes from production
    // workspaces (cls.objects, chained .filter().filter(), @property
    // returning queryset, self.<relation>.filter, values/values_list
    // chains). The earlier fixtures each isolated one pattern; this
    // exercises them together so a regression in any path is caught.
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      await openFixtureDocument(
        fixtureRoot,
        'blog/realistic_workspace_lookup_examples.py'
      );

      const matchesFireForDoc = (line: string): boolean =>
        line.startsWith('[diagnostics:trigger] fire ') &&
        line.endsWith('blog/realistic_workspace_lookup_examples.py');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        15_000
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        20_000
      );

      const buf = getDiagnosticLogBufferForTesting();
      let totalValid = 0;
      let totalNoRecv = 0;
      const sampleSnippets: string[] = [];
      const phase2Re = /\[diagnostics:phase\] phase2-lookups:[^ ]+ .*? valid=(\d+) added=\d+ exit=cancelled:\d+,noRecv:(\d+).*?(?: noRecvSamples=\[([^\]]*)\])?$/;
      const visRecRe = /\[diagnostics:phase\] receivers-visible .*? validated=(\d+) pending=\d+ batchItems=\d+ receivers=\d+ missing=(\d+) virtual=\d+/;
      for (const line of buf) {
        const m = phase2Re.exec(line);
        if (m) {
          totalValid += Number(m[1]);
          totalNoRecv += Number(m[2]);
          if (m[3]) sampleSnippets.push(m[3]);
          continue;
        }
        const r = visRecRe.exec(line);
        if (r) {
          totalValid += Number(r[1]);
          totalNoRecv += Number(r[2]);
        }
      }

      assert.ok(
        totalValid >= 15,
        `Expected the realistic-workspace fixture to validate many lookups (>= 15). ` +
        `Got totalValid=${totalValid}.`
      );
      // Allow a single missed receiver as a soft margin (e.g. an idiom we
      // genuinely do not yet support), but the broad mix here should
      // overwhelmingly resolve. If noRecv ever rises substantially this
      // signals a regression in one of the patterns the fixture covers.
      assert.ok(
        totalNoRecv <= 1,
        `Expected at most 1 noRecv across the realistic-workspace fixture. ` +
        `Got totalNoRecv=${totalNoRecv}/${totalValid}. ` +
        `Samples: ${sampleSnippets.join(' | ')}\n` +
        `phase2-lookups lines:\n  ` +
        buf.filter((l) => l.includes('phase2-lookups:')).join('\n  ') + '\n' +
        `receivers-visible lines:\n  ` +
        buf.filter((l) => l.includes('receivers-visible')).join('\n  ')
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
    }
  });

  test('cross-app workspace models resolve as lookup receivers', async function () {
    // Production trace captured `RegistrationAssistance.objects`,
    // `SelfRegistration.objects`, `OptionProxy.objects` as noRecv samples —
    // workspace-defined models that live in a different app's directory
    // than the file being scanned. This test uses Vendor (in `org/models/`)
    // referenced from a fixture file in `blog/`.
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      await openFixtureDocument(
        fixtureRoot,
        'blog/cross_app_lookup_examples.py'
      );

      const matchesFireForDoc = (line: string): boolean =>
        line.startsWith('[diagnostics:trigger] fire ') &&
        line.endsWith('blog/cross_app_lookup_examples.py');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        15_000
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        20_000
      );

      const buf = getDiagnosticLogBufferForTesting();
      let totalValid = 0;
      let totalNoRecv = 0;
      const sampleSnippets: string[] = [];
      const phase2Re = /\[diagnostics:phase\] phase2-lookups:[^ ]+ .*? valid=(\d+) added=\d+ exit=cancelled:\d+,noRecv:(\d+).*?(?: noRecvSamples=\[([^\]]*)\])?$/;
      const visRecRe = /\[diagnostics:phase\] receivers-visible .*? validated=(\d+) pending=\d+ batchItems=\d+ receivers=\d+ missing=(\d+) virtual=\d+/;
      for (const line of buf) {
        const m = phase2Re.exec(line);
        if (m) {
          totalValid += Number(m[1]);
          totalNoRecv += Number(m[2]);
          if (m[3]) sampleSnippets.push(m[3]);
          continue;
        }
        const r = visRecRe.exec(line);
        if (r) {
          totalValid += Number(r[1]);
          totalNoRecv += Number(r[2]);
        }
      }

      assert.ok(
        totalValid >= 5,
        `Expected cross-app lookups to validate (>= 5). Got totalValid=${totalValid}.`
      );
      assert.strictEqual(
        totalNoRecv,
        0,
        `Expected zero noRecv for 'Vendor.objects' (Vendor lives in org/models). ` +
        `Got totalNoRecv=${totalNoRecv}/${totalValid}. ` +
        `Samples: ${sampleSnippets.join(' | ')}\n` +
        `phase2-lookups lines:\n  ` +
        buf.filter((l) => l.includes('phase2-lookups:')).join('\n  ') + '\n' +
        `receivers-visible lines:\n  ` +
        buf.filter((l) => l.includes('receivers-visible')).join('\n  ')
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
    }
  });

  test('Django built-in model receivers resolve via static-fallback', async function () {
    // Production trace captured `User.objects` as a noRecv sample because
    // the workspace-discovery pass misses Django's own packaged models
    // (auth.User, contenttypes.ContentType, sessions.Session, ...). This
    // test verifies the daemon now ships a built-in static-fallback bundle
    // so those receivers resolve and lookups are validated.
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      await openFixtureDocument(
        fixtureRoot,
        'blog/builtin_model_lookup_examples.py'
      );

      const matchesFireForDoc = (line: string): boolean =>
        line.startsWith('[diagnostics:trigger] fire ') &&
        line.endsWith('blog/builtin_model_lookup_examples.py');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        15_000
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        20_000
      );

      const buf = getDiagnosticLogBufferForTesting();
      let totalValid = 0;
      let totalNoRecv = 0;
      const sampleSnippets: string[] = [];
      const phase2Re = /\[diagnostics:phase\] phase2-lookups:[^ ]+ .*? valid=(\d+) added=\d+ exit=cancelled:\d+,noRecv:(\d+).*?(?: noRecvSamples=\[([^\]]*)\])?$/;
      const visRecRe = /\[diagnostics:phase\] receivers-visible .*? validated=(\d+) pending=\d+ batchItems=\d+ receivers=\d+ missing=(\d+) virtual=\d+/;
      for (const line of buf) {
        const m = phase2Re.exec(line);
        if (m) {
          totalValid += Number(m[1]);
          totalNoRecv += Number(m[2]);
          if (m[3]) sampleSnippets.push(m[3]);
          continue;
        }
        const r = visRecRe.exec(line);
        if (r) {
          totalValid += Number(r[1]);
          totalNoRecv += Number(r[2]);
        }
      }

      assert.ok(
        totalValid >= 10,
        `Expected built-in lookups to validate (>= 10). Got totalValid=${totalValid}.`
      );
      assert.strictEqual(
        totalNoRecv,
        0,
        `Expected zero noRecv for receivers like 'User.objects'. ` +
        `Got totalNoRecv=${totalNoRecv}/${totalValid}. ` +
        `Samples: ${sampleSnippets.join(' | ')}\n` +
        `phase2-lookups lines:\n  ` +
        buf.filter((l) => l.includes('phase2-lookups:')).join('\n  ') + '\n' +
        `receivers-visible lines:\n  ` +
        buf.filter((l) => l.includes('receivers-visible')).join('\n  ')
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
    }
  });

  test('plural-named parameters resolve to singular models via fuzzy fallback', async function () {
    // Variable named `vendors` (plural) referring to the `Vendor` singular
    // model. The receiver resolver now tries "drop trailing 's'" variants
    // so plural collection-style parameters still resolve without explicit
    // type annotations.
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      await openFixtureDocument(
        fixtureRoot,
        'blog/plural_param_lookup_examples.py'
      );

      const matchesFireForDoc = (line: string): boolean =>
        line.startsWith('[diagnostics:trigger] fire ') &&
        line.endsWith('blog/plural_param_lookup_examples.py');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        15_000
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        20_000
      );

      const buf = getDiagnosticLogBufferForTesting();
      let totalValid = 0;
      let totalNoRecv = 0;
      const sampleSnippets: string[] = [];
      const phase2Re = /\[diagnostics:phase\] phase2-lookups:[^ ]+ .*? valid=(\d+) added=\d+ exit=cancelled:\d+,noRecv:(\d+).*?(?: noRecvSamples=\[([^\]]*)\])?$/;
      const visRecRe = /\[diagnostics:phase\] receivers-visible .*? validated=(\d+) pending=\d+ batchItems=\d+ receivers=\d+ missing=(\d+) virtual=\d+/;
      for (const line of buf) {
        const m = phase2Re.exec(line);
        if (m) {
          totalValid += Number(m[1]);
          totalNoRecv += Number(m[2]);
          if (m[3]) sampleSnippets.push(m[3]);
          continue;
        }
        const r = visRecRe.exec(line);
        if (r) {
          totalValid += Number(r[1]);
          totalNoRecv += Number(r[2]);
        }
      }

      assert.ok(
        totalValid >= 8,
        `Expected plural-param lookups to validate (>= 8). Got ${totalValid}.`
      );
      assert.strictEqual(
        totalNoRecv,
        0,
        `Expected zero noRecv for 'vendors.filter(...)' where 'vendors' is ` +
        `an unannotated plural parameter mapping to singular Vendor model. ` +
        `Got totalNoRecv=${totalNoRecv}/${totalValid}. ` +
        `Samples: ${sampleSnippets.join(' | ')}\n` +
        `phase2-lookups lines:\n  ` +
        buf.filter((l) => l.includes('phase2-lookups:')).join('\n  ') + '\n' +
        `receivers-visible lines:\n  ` +
        buf.filter((l) => l.includes('receivers-visible')).join('\n  ')
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
    }
  });

  test('unannotated function parameters resolve via snake_case→PascalCase fallback', async function () {
    // Production trace captured `directors_meeting.director_attendance_set`
    // as a noRecv sample. `directors_meeting` is a function parameter that
    // is NOT type-annotated, but its snake_case name happens to match a
    // PascalCase model (`DirectorsMeeting`). The receiver resolver has a
    // snake→pascal fallback at resolveOrmReceiverAtOffsetCore; this test
    // verifies it resolves through the diagnostic pipeline so reverse
    // accessors like `.director_attendance_set` work without explicit type
    // annotations.
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      await openFixtureDocument(
        fixtureRoot,
        'blog/unannotated_param_lookup_examples.py'
      );

      const matchesFireForDoc = (line: string): boolean =>
        line.startsWith('[diagnostics:trigger] fire ') &&
        line.endsWith('blog/unannotated_param_lookup_examples.py');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        15_000
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        20_000
      );

      const buf = getDiagnosticLogBufferForTesting();
      let totalValid = 0;
      let totalNoRecv = 0;
      const sampleSnippets: string[] = [];
      const phase2Re = /\[diagnostics:phase\] phase2-lookups:[^ ]+ .*? valid=(\d+) added=\d+ exit=cancelled:\d+,noRecv:(\d+).*?(?: noRecvSamples=\[([^\]]*)\])?$/;
      const visRecRe = /\[diagnostics:phase\] receivers-visible .*? validated=(\d+) pending=\d+ batchItems=\d+ receivers=\d+ missing=(\d+) virtual=\d+/;
      for (const line of buf) {
        const m = phase2Re.exec(line);
        if (m) {
          totalValid += Number(m[1]);
          totalNoRecv += Number(m[2]);
          if (m[3]) sampleSnippets.push(m[3]);
          continue;
        }
        const r = visRecRe.exec(line);
        if (r) {
          totalValid += Number(r[1]);
          totalNoRecv += Number(r[2]);
        }
      }

      assert.ok(
        totalValid >= 8,
        `Expected unannotated-param lookups to validate (>= 8). Got ${totalValid}.`
      );
      assert.strictEqual(
        totalNoRecv,
        0,
        `Expected zero noRecv for 'author.posts' where 'author' is an ` +
        `unannotated parameter. Got totalNoRecv=${totalNoRecv}/${totalValid}. ` +
        `Samples: ${sampleSnippets.join(' | ')}\n` +
        `phase2-lookups lines:\n  ` +
        buf.filter((l) => l.includes('phase2-lookups:')).join('\n  ') + '\n' +
        `receivers-visible lines:\n  ` +
        buf.filter((l) => l.includes('receivers-visible')).join('\n  ')
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
    }
  });

  test('annotated function parameters resolve as lookup receivers', async function () {
    // Production trace captured `directors_meeting.director_attendance_set`
    // as a noRecv sample — `directors_meeting` is a function parameter
    // annotated as `DirectorsMeeting`. The receiver-resolution infrastructure
    // (`findFunctionParameterTypeAnnotation`,
    //  `resolveAnnotatedReceiverForMemberAccess`) already exists. This test
    // verifies the integration works end-to-end so reverse-accessor lookups
    // on annotated parameters don't end up in the noRecv bucket.
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      await openFixtureDocument(
        fixtureRoot,
        'blog/annotated_param_lookup_examples.py'
      );

      const matchesFireForDoc = (line: string): boolean =>
        line.startsWith('[diagnostics:trigger] fire ') &&
        line.endsWith('blog/annotated_param_lookup_examples.py');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        15_000
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        20_000
      );

      const buf = getDiagnosticLogBufferForTesting();
      let totalValid = 0;
      let totalNoRecv = 0;
      const sampleSnippets: string[] = [];
      const phase2Re = /\[diagnostics:phase\] phase2-lookups:[^ ]+ .*? valid=(\d+) added=\d+ exit=cancelled:\d+,noRecv:(\d+).*?(?: noRecvSamples=\[([^\]]*)\])?$/;
      const visRecRe = /\[diagnostics:phase\] receivers-visible .*? validated=(\d+) pending=\d+ batchItems=\d+ receivers=\d+ missing=(\d+) virtual=\d+/;
      for (const line of buf) {
        const m = phase2Re.exec(line);
        if (m) {
          totalValid += Number(m[1]);
          totalNoRecv += Number(m[2]);
          if (m[3]) sampleSnippets.push(m[3]);
          continue;
        }
        const r = visRecRe.exec(line);
        if (r) {
          totalValid += Number(r[1]);
          totalNoRecv += Number(r[2]);
        }
      }

      assert.ok(
        totalValid >= 10,
        `Expected the fixture's annotated-parameter lookups to validate (>= 10). ` +
        `Got totalValid=${totalValid}.`
      );
      assert.strictEqual(
        totalNoRecv,
        0,
        `Expected zero noRecv for receivers like 'author.posts' where 'author' has ` +
        `a function-parameter type annotation. Got totalNoRecv=${totalNoRecv}/${totalValid}. ` +
        `Samples: ${sampleSnippets.join(' | ')}\n` +
        `phase2-lookups lines:\n  ` +
        buf.filter((l) => l.includes('phase2-lookups:')).join('\n  ') + '\n' +
        `receivers-visible lines:\n  ` +
        buf.filter((l) => l.includes('receivers-visible')).join('\n  ')
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
    }
  });

  test('multiple promote reasons coalesce while a diagnostic scan is in flight', async function () {
    // Production-observed regression: two distinct promote reasons (e.g.
    // language-client-started and daemon-ready) arriving back-to-back during
    // an in-flight scan. The first one schedules a defer timer; the second
    // — with a different reason — bypassed the deferral guard and killed
    // the scan. The fix ensures BOTH return early: one as "Deferred ...",
    // the other as "Coalesced ...".
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '500';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      await openFixtureDocument(
        fixtureRoot,
        'blog/heavy_lookup_examples.py'
      );

      let inFlightObserved = false;
      const tStart = Date.now();
      while (Date.now() - tStart < 10_000) {
        if (getActiveDiagnosticScanRunningCountForTesting() >= 1) {
          inFlightObserved = true;
          break;
        }
        await delay(5);
      }
      assert.ok(inFlightObserved, 'Cycle 1 should reach in-flight state.');

      // Fire TWO promotions with distinct reasons back-to-back while the
      // scan is still in flight.
      promotePythonProvidersForTesting('test-reason-A');
      promotePythonProvidersForTesting('test-reason-B');

      // Expect one Deferred line for A and one Coalesced line for B.
      await waitForCondition(
        () => {
          const buf = getDiagnosticLogBufferForTesting();
          return buf.some((l) =>
            l.includes('Deferred Python provider promotion (test-reason-A)')
          ) && buf.some((l) =>
            l.includes('Coalesced Python provider promotion (test-reason-B)')
          );
        },
        5_000
      );

      // While the scan is still in flight, NEITHER reason should have
      // emitted a Re-registered line. Snapshot now to capture in-flight state.
      const inFlightBuf = getDiagnosticLogBufferForTesting();
      const inFlightReRegisters = inFlightBuf.filter((l) =>
        l.includes('Re-registered Python providers (test-reason-A)') ||
        l.includes('Re-registered Python providers (test-reason-B)')
      );
      assert.strictEqual(
        inFlightReRegisters.length,
        0,
        `Re-registration must not happen while scan is in flight. Saw:\n` +
        inFlightReRegisters.join('\n') +
        '\nRecent log lines:\n' +
        getDiagnosticLogBufferForTesting().slice(-30).join('\n')
      );

      // Once the scan ends, the deferred A promotion should fire (B is
      // coalesced and dropped, which is fine — both just dispose+recreate).
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        20_000
      );
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some((l) =>
          l.includes('Re-registered Python providers (test-reason-A)')
        ),
        5_000
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
    }
  });

  // ---------------------------------------------------------------------------
  // Failing-on-purpose regression tests for problems A–D identified in the
  // 2026-05-12 captain log analysis. Each test reproduces a production bug
  // observed in the captain workspace; they fail in the current build and
  // will pass once the corresponding fix lands.
  // ---------------------------------------------------------------------------

  test('A: scan cache hits even when visible range drifts a few lines (captain L48 vs L99)', async function () {
    // Captain trace shows Cycle 1 scanning lines 143-290 and Cycle 2 (same
    // version, same document) scanning lines 140-287 — a 3-line drift caused
    // by a tiny scroll or editor resize between cycles. The scan cache is
    // keyed by exact (docUri, version, range), so trivial drift produces a
    // cache miss and ~1.5s of phase2-scan is repeated.
    //
    // Desired behavior: cache should be tolerant to small range shifts (or
    // keyed by content) so the same-version re-scan reuses prior work.
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      const document = await openFixtureDocument(
        fixtureRoot,
        'blog/heavy_lookup_examples.py'
      );
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor && editor.document.uri.toString() === document.uri.toString(),
        'fixture editor must be active for revealRange to take effect'
      );

      // Position visible range deep into the file (not at line 0, otherwise
      // both reveal calls end up at the start and no drift occurs).
      editor.revealRange(
        new vscode.Range(200, 0, 200, 0),
        vscode.TextEditorRevealType.AtTop
      );
      await delay(300);

      // Wait for Cycle 1 publish.
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(
          (l) => l.startsWith('[diagnostics:phase] publish')
        ),
        25_000
      );
      const cycle1End = getDiagnosticLogBufferForTesting().length;

      // Drift the visible range by a few lines (mirrors the captain 3-line
      // delta) before triggering Cycle 2.
      editor.revealRange(
        new vscode.Range(203, 0, 203, 0),
        vscode.TextEditorRevealType.AtTop
      );
      await delay(300);

      // Trigger same-version Cycle 2 via promote (so cache pre-existing
      // entries are intact).
      promotePythonProvidersForTesting('scan-range-drift-test');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some((l) =>
          l.includes('Re-registered Python providers (scan-range-drift-test)')
        ),
        25_000
      );
      await waitForCondition(
        () => {
          const buf = getDiagnosticLogBufferForTesting();
          const tail = buf.slice(cycle1End);
          return tail.some((l) => l.startsWith('[diagnostics:phase] publish'));
        },
        25_000
      );

      const buf = getDiagnosticLogBufferForTesting();
      const cycle2Lines = buf.slice(cycle1End);
      const cycle2ScanCompletes = cycle2Lines.filter((l) =>
        l.includes('[diagnostics:scan] complete')
      );
      const cycle2Phase2 = cycle2Lines.filter((l) =>
        l.includes('[diagnostics:phase] phase2-scan:')
      );
      assert.ok(
        cycle2ScanCompletes.length > 0 || cycle2Phase2.length > 0,
        `Cycle 2 must emit scan lines`
      );

      const allCycle2Scans = [...cycle2ScanCompletes, ...cycle2Phase2];
      const misses = allCycle2Scans.filter((l) => l.includes('cache=miss'));
      assert.strictEqual(
        misses.length,
        0,
        `Same-version Cycle 2 scans must reuse Cycle 1's cached results ` +
        `despite a small visible-range drift (3 lines). Got ${misses.length} ` +
        `misses:\n  ${misses.join('\n  ')}\n` +
        `Cycle 1 scan lines:\n  ${buf.slice(0, cycle1End).filter((l) =>
          l.includes('[diagnostics:scan] complete') ||
          l.includes('[diagnostics:phase] phase2-scan:')
        ).join('\n  ')}\n` +
        `Cycle 2 scan lines:\n  ${allCycle2Scans.join('\n  ')}`
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
    }
  });

  test('B: classifier normalizes `return <KnownModel>...` prefix before extracting root', async function () {
    // Captain trace L81/L138 noRecvSamples included
    // `return Director.objects.get_queryset()#unknown_root` — the classifier
    // extracted `return` as the root identifier from the unnormalized
    // receiver expression and never noticed `Director` is a known model.
    // The resolver normalizes the expression before resolving; the
    // classifier must do the same so the bucket actually reflects the bug
    // (root_matched on a real model instead of unknown_root).
    //
    // Direct classifier test: the resolver's snake-pascal fallback resolves
    // any chain rooted in a known model to a generic instance, so a fully
    // E2E reproduction is hard to force. Invoke the classifier directly via
    // a test hook to assert the bucket would be correct if the resolver did
    // fail.
    this.timeout(15_000);
    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);
    await waitForCondition(
      () => getActiveDiagnosticScanRunningCountForTesting() === 0,
      15_000
    );

    const daemon = getActiveDaemonForTesting();
    assert.ok(daemon, 'daemon must be active');
    // Confirm Author IS in the model index (minimal_project ships it via
    // blog.models.Author). The classifier should therefore recognize it.
    assert.ok(
      daemon.modelLabelByName.has('Author') ||
      daemon.localWorkspaceIndexForTesting.modelLabelByName.has('Author'),
      'fixture workspace must have Author in modelLabelByName'
    );

    const samples = [
      'return Author.objects.get_queryset()',
      'return Author.objects.NONEXISTENT',
      'return Author.objects.NONEXISTENT.filter(name="x")',
      'return Author.posts.filter(title="x")',
    ];
    const results = samples.map((expr) => ({
      expr,
      bucket: classifyNoRecvReasonForTesting(daemon, expr),
    }));

    for (const { expr, bucket } of results) {
      assert.ok(
        bucket.startsWith('root_matched:Author') ||
        bucket.startsWith('fuzzy_matched:Author'),
        `Classifier must normalize the receiver expression and recognize ` +
        `Author as the root after stripping the 'return ' prefix. ` +
        `Expected bucket starting with 'root_matched:Author' (or fuzzy_matched). ` +
        `expr=${JSON.stringify(expr)} → bucket=${bucket}\n` +
        `All results:\n  ${results.map((r) => `${r.expr} → ${r.bucket}`).join('\n  ')}`
      );
    }
  });

  test('C: self.<related_name>_set resolves as reverse manager inside class methods', async function () {
    // Captain trace L81/L138 noRecvSamples include
    // `self.all_stock_set.valid_at(date)#no_root_identifier` — `self` is
    // explicitly excluded by receiverRootIdentifier so the classifier marks
    // the lookup as no_root_identifier and the resolver returns undefined
    // for the receiver. Real Django code uses `self.<related_name>_set`
    // routinely inside model methods, so these must resolve to the reverse
    // manager of the enclosing class.
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      await openFixtureDocument(
        fixtureRoot,
        'blog/self_reverse_manager_examples.py'
      );

      const matchesFireForDoc = (line: string): boolean =>
        line.startsWith('[diagnostics:trigger] fire ') &&
        line.endsWith('blog/self_reverse_manager_examples.py');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        15_000
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        25_000
      );

      const buf = getDiagnosticLogBufferForTesting();
      // Small fixtures land entirely in visible-first, so check both
      // receivers-visible and phase2-lookups noRecv reasons.
      const phaseLines = buf.filter((l) =>
        l.includes('phase2-lookups:') || l.includes('receivers-visible')
      );
      const reasonsRe = /noRecvReasons=([^\s]+)/;
      const samplesRe = /noRecvSamples=\[([^\]]*)\]/;
      let allReasons = '';
      let allSamples = '';
      for (const line of phaseLines) {
        const r = reasonsRe.exec(line);
        if (r) allReasons += r[1] + ',';
        const s = samplesRe.exec(line);
        if (s) allSamples += s[1] + ' | ';
      }

      // Desired: `self.<X>` patterns should NOT fall into `no_root_identifier`.
      // Either the resolver succeeds (preferred) or the classifier emits a
      // more specific bucket (e.g. self_reference). Either way the bucket
      // `no_root_identifier` should be empty for this fixture, which contains
      // only `self.<X>_set.filter(...)` patterns.
      const noRootIdentifierMatch = /\bno_root_identifier:(\d+)/.exec(allReasons);
      const noRootIdentifierCount = noRootIdentifierMatch
        ? Number(noRootIdentifierMatch[1])
        : 0;
      assert.ok(
        phaseLines.length > 0,
        `Test must observe phase lines from the fixture. Got 0.\n` +
        `Recent buffer lines:\n  ${buf.slice(-30).join('\n  ')}`
      );

      // After the classifier fix, `self.<X>` patterns must NOT be bucketed
      // as the generic `no_root_identifier` or `unknown_root` — they should
      // get a dedicated `self_reference:self` (or :cls/:super) bucket so
      // diagnostics surface separates them from "literal/punctuation-prefix"
      // receivers (the original meaning of no_root_identifier) and from
      // truly unknown roots.
      const selfReferenceMatch = /\bself_reference:(self|cls|super):(\d+)/g;
      const selfRefCount = [...allReasons.matchAll(selfReferenceMatch)]
        .reduce((sum, m) => sum + Number(m[2]), 0);
      assert.ok(
        selfRefCount >= 5,
        `Captain regression: 'self.<X>' samples must be bucketed as ` +
        `self_reference (not no_root_identifier / unknown_root). The fixture ` +
        `has 5 self.<X>_set patterns; got self_reference count=${selfRefCount}.\n` +
        `noRecvReasons=${allReasons}\n` +
        `noRecvSamples=${allSamples}\n` +
        `Diagnostic phase lines:\n  ${phaseLines.join('\n  ')}`
      );
      // Also assert these are NOT in the old buckets.
      assert.strictEqual(
        noRootIdentifierCount,
        0,
        `self.<X> patterns must not be classified as the generic ` +
        `no_root_identifier bucket. Got ${noRootIdentifierCount}.\n` +
        `noRecvReasons=${allReasons}`
      );
      const unknownRootMatch = /\bunknown_root:(\d+)/.exec(allReasons);
      const unknownRootCount = unknownRootMatch ? Number(unknownRootMatch[1]) : 0;
      assert.strictEqual(
        unknownRootCount,
        0,
        `self.<X> patterns must not be classified as unknown_root. ` +
        `Got ${unknownRootCount}.\n` +
        `noRecvReasons=${allReasons}`
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
    }
  });

  test('D: cached null is invalidated when root identifier becomes known after cold start', async function () {
    // Captain Cycle 1 (v=1) noRecvReasons included root_matched:CompanyUserRelation
    // (7), root_matched:PayrollAnnualSalaryInfo (6), etc. — workspace models
    // that ARE in the modelLabelByName at classifier time but were absent at
    // resolution time. Cycle 1 stores `null` in the receiver cache (with the
    // "don't pin when root is a known model" guard), but the guard only fires
    // when the model is known at the .then() callback — if the surface delta
    // arrives AFTER that, the null pins indefinitely.
    //
    // Production effect: cycle 1 burns time on resolutions, returns null,
    // pins the null, and subsequent same-version cycles return the stale
    // null — even though the daemon now knows the model.
    //
    // Desired behavior: on cache READ, re-validate the null against the
    // current modelLabelByName and re-resolve if the root is now known.
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      // Step 1: simulate a fully cold daemon — both modelLabelByName and
      // localWorkspaceIndex.modelLabelByName empty. This mirrors the captain
      // cycle 1 state before the surface delta arrives.
      const daemon = getActiveDaemonForTesting();
      assert.ok(daemon, 'daemon must be active');
      clearDaemonModelLabelByNameForTesting(daemon);
      const savedLwiByName = new Map(daemon.localWorkspaceIndexForTesting.modelLabelByName);
      daemon.localWorkspaceIndexForTesting.modelLabelByName.clear();

      // Step 2: open builtin_model_lookup_examples.py — the Django built-in
      // static fallback would normally repopulate User/Group/Permission in
      // modelLabelByName. Since we cleared both maps, every lookup will fail.
      // BUT we need to prevent the static fallback rebuild from undoing our
      // clear, so we patch in a flag after opening.
      await openFixtureDocument(
        fixtureRoot,
        'blog/builtin_model_lookup_examples.py'
      );

      // Re-clear after open in case opening rebuilt anything.
      clearDaemonModelLabelByNameForTesting(daemon);
      daemon.localWorkspaceIndexForTesting.modelLabelByName.clear();

      // Wait for Cycle 1 to publish with cold maps. Every .objects lookup
      // should land in noRecv and a null gets pinned in the receiver cache.
      const cycle1Buf = await (async () => {
        const matchesFireForDoc = (line: string): boolean =>
          line.startsWith('[diagnostics:trigger] fire ') &&
          line.endsWith('blog/builtin_model_lookup_examples.py');
        await waitForCondition(
          () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
          15_000
        );
        await waitForCondition(
          () => getActiveDiagnosticScanRunningCountForTesting() === 0,
          20_000
        );
        return getDiagnosticLogBufferForTesting().slice();
      })();

      // Step 3: restore the maps (simulate surface delta arriving).
      for (const [k, v] of savedLwiByName) {
        daemon.localWorkspaceIndexForTesting.modelLabelByName.set(k, v);
      }
      // Force daemon.modelLabelByName to repopulate. The simplest restore
      // path is to invoke whatever rebuilds it. For the test, mirror the
      // localWorkspaceIndex contents.
      for (const [k, v] of savedLwiByName) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (daemon as any).modelLabelByName.set(k, v);
      }
      assert.ok(
        daemon.modelLabelByName.size > 0,
        'restore must repopulate daemon.modelLabelByName'
      );

      const cycle1End = cycle1Buf.length;
      clearDiagnosticLogBufferForTesting();

      // Step 4: trigger Cycle 2 same-version via promote. The receiver cache
      // still holds stale nulls from Cycle 1; the fix should invalidate them
      // on read since the root is now known.
      promotePythonProvidersForTesting('stale-null-cache-test');

      const matchesFireForDoc = (line: string): boolean =>
        line.startsWith('[diagnostics:trigger] fire ') &&
        line.endsWith('blog/builtin_model_lookup_examples.py');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        20_000
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        20_000
      );

      const buf = getDiagnosticLogBufferForTesting();
      let totalValid = 0;
      let totalNoRecv = 0;
      const samples: string[] = [];
      const phase2Re = /\[diagnostics:phase\] phase2-lookups:[^ ]+ .*? valid=(\d+) added=\d+ exit=cancelled:\d+,noRecv:(\d+).*?(?: noRecvSamples=\[([^\]]*)\])?$/;
      const visRecRe = /\[diagnostics:phase\] receivers-visible .*? validated=(\d+) pending=\d+ batchItems=\d+ receivers=\d+ missing=(\d+) virtual=\d+/;
      for (const line of buf) {
        const m = phase2Re.exec(line);
        if (m) {
          totalValid += Number(m[1]);
          totalNoRecv += Number(m[2]);
          if (m[3]) samples.push(m[3]);
          continue;
        }
        const r = visRecRe.exec(line);
        if (r) {
          totalValid += Number(r[1]);
          totalNoRecv += Number(r[2]);
        }
      }

      // Cycle 1 (cold) suppressed totalNoRecv pollution from the prior cycle.
      // Use only the Cycle 2 buffer for the assertion.
      assert.ok(
        totalValid >= 5,
        `Cycle 2 must validate lookups after maps are restored. ` +
        `Got totalValid=${totalValid}. ` +
        `Cycle 1 had ${cycle1End} lines; Cycle 2 has ${buf.length} lines.`
      );
      assert.strictEqual(
        totalNoRecv,
        0,
        `Cycle 2 must invalidate stale cached nulls when the root identifier ` +
        `is now known. Got totalNoRecv=${totalNoRecv}/${totalValid}. ` +
        `Samples: ${samples.join(' | ')}\n` +
        `Cycle 2 phase2-lookups lines:\n  ` +
        buf.filter((l) => l.includes('phase2-lookups:')).join('\n  ')
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
    }
  });

  test('A-followup: scan cache hits even when visible range drifts beyond the grid (captain 50-line scroll)', async function () {
    // The first A fix snapped range boundaries to a 50-line grid so small
    // (≤50 line) scrolls produce identical cache keys. Captain log L37 vs
    // L83 shows a 50-line drift between cycles (100-300 → 150-350), which
    // crosses the grid boundary and produces different snapped keys —
    // every scan cache=miss again.
    //
    // Desired: the cache should reuse work from prior scans whenever
    // the new query range is a SUBSET of (or overlaps with) previously
    // scanned line ranges. Same-version means the document text is
    // unchanged, so any line scanned before yields the same contexts.
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      const document = await openFixtureDocument(
        fixtureRoot,
        'blog/heavy_lookup_examples.py'
      );
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor && editor.document.uri.toString() === document.uri.toString());

      // Cycle 1 viewport at line 100.
      editor.revealRange(
        new vscode.Range(100, 0, 100, 0),
        vscode.TextEditorRevealType.AtTop
      );
      await delay(300);

      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(
          (l) => l.startsWith('[diagnostics:phase] publish')
        ),
        25_000
      );
      const cycle1End = getDiagnosticLogBufferForTesting().length;

      // Cycle 2 viewport at line 200 (100-line drift — crosses ALL 50-line
      // grid boundaries the current fix relies on).
      editor.revealRange(
        new vscode.Range(200, 0, 200, 0),
        vscode.TextEditorRevealType.AtTop
      );
      await delay(300);

      promotePythonProvidersForTesting('scan-large-drift-test');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some((l) =>
          l.includes('Re-registered Python providers (scan-large-drift-test)')
        ),
        25_000
      );
      await waitForCondition(
        () => {
          const buf = getDiagnosticLogBufferForTesting();
          const tail = buf.slice(cycle1End);
          return tail.some((l) => l.startsWith('[diagnostics:phase] publish'));
        },
        25_000
      );

      const buf = getDiagnosticLogBufferForTesting();
      const cycle2Lines = buf.slice(cycle1End);
      const cycle2Scans = cycle2Lines.filter((l) =>
        l.includes('[diagnostics:scan] complete') ||
        l.includes('[diagnostics:phase] phase2-scan:')
      );
      assert.ok(
        cycle2Scans.length > 0,
        `Cycle 2 must emit scan lines`
      );

      const misses = cycle2Scans.filter((l) => l.includes('cache=miss'));
      assert.strictEqual(
        misses.length,
        0,
        `After a 100-line scroll, Cycle 2 scans must reuse Cycle 1's ` +
        `cached lookups (the document text is unchanged for v=1, so ` +
        `any previously scanned line yields the same contexts). Got ` +
        `${misses.length} misses:\n  ${misses.join('\n  ')}\n` +
        `Cycle 1 scan lines:\n  ${buf.slice(0, cycle1End).filter((l) =>
          l.includes('[diagnostics:scan] complete') ||
          l.includes('[diagnostics:phase] phase2-scan:')
        ).join('\n  ')}\n` +
        `Cycle 2 scan lines:\n  ${cycle2Scans.join('\n  ')}`
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
    }
  });

  test('captain P1: phase2-lookups should not exhaust the 10s budget on 500+ valid lookups with default per-context cap', async function () {
    // Captain log 2026-05-12 14:23 shows three cycles (1, 6, 7) hitting
    // time-budget exhausted on `services/demo_company_service.py`:
    //   phase2-lookups:550-2499 7212ms, requests=28, valid=34, resolvedOk=20,
    //   noRecv=8, timeout=2 (input=514)
    // → out of 514 input lookups, only ~28 contexts were processed before
    // budget exhaust → publish partial=true diagnostics=0.
    //
    // Root cause: each context can take up to PHASE2_PER_CONTEXT_TIMEOUT_MS
    // (1500ms default). With concurrency=4 and natural BG IPC delays just
    // under that cap, each batch of 4 takes ~1s and the budget tops out
    // after ~30-40 contexts.
    //
    // Reproduce: heavy_lookup_examples.py has hundreds of valid lookups,
    // each requiring BG IPC. With default config and an injected ~800ms
    // per-IPC delay (close to but below the per-context cap), the budget
    // exhausts before most contexts complete — mirrors captain.
    //
    // This test asserts the FIXED state (publish.partial=false) so it fails
    // today and unblocks future fix work (lower default cap / skip phase2
    // on large files / etc.).
    this.timeout(60_000);
    // Reproduce captain's budget-exhaust shape on minimal_project's smaller
    // scale: shrink the diagnostic budget and amplify per-IPC latency
    // simultaneously so the same "many slow contexts" choke point manifests.
    // (Captain natural scale: ~1318 models × ~30 distinct lookup triples ×
    // ~250ms IPC → 7s phase2-lookups, exhausts 10s budget. We mirror that
    // ratio here by using tighter limits.)
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '3000';
    process.env.DJLS_TEST_RESOLVE_LOOKUP_PATH_DELAY_MS = '1200';
    process.env.DJLS_TEST_RESOLVE_ORM_MEMBER_DELAY_MS = '1200';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      // heavy_invalid_lookup_examples has many DISTINCT (model, value,
      // method) triplets (`nonexistent_field_000__*` … `_NNN__*`) so the
      // per-lookup IPC cache cannot deduplicate them — the injected delay
      // accumulates and the budget exhausts. heavy_lookup_examples by
      // contrast repeats `title__contains` etc. and the cache absorbs the
      // load on the very first cycle, hiding the captain bug.
      await openFixtureDocument(
        fixtureRoot,
        'blog/heavy_invalid_lookup_examples.py'
      );

      const matchesFireForDoc = (line: string): boolean =>
        line.startsWith('[diagnostics:trigger] fire ') &&
        line.endsWith('blog/heavy_invalid_lookup_examples.py');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        15_000
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        25_000
      );

      const buf = getDiagnosticLogBufferForTesting();
      const publishLine = buf.find((l) =>
        l.startsWith('[diagnostics:phase] publish')
      );
      assert.ok(publishLine, 'diagnostic cycle must publish');

      const partialMatch = /partial=(true|false)/.exec(publishLine);
      assert.ok(partialMatch, `publish line must include partial=: ${publishLine}`);
      const partial = partialMatch[1] === 'true';

      // Aggregate phase2-lookups input vs processed counts.
      const phase2Lines = buf.filter((l) => l.includes('[diagnostics:phase] phase2-lookups:'));
      let totalInput = 0;
      let totalProcessed = 0;
      const exitRe = /input=(\d+)\s+valid=(\d+)\s+added=\d+\s+exit=cancelled:(\d+),noRecv:(\d+),virtual:(\d+),resolvedOk:(\d+),partialSuppress:(\d+),dedup:(\d+),nullDiag:(\d+),err:(\d+),timeout:(\d+)/;
      for (const line of phase2Lines) {
        const m = exitRe.exec(line);
        if (!m) continue;
        totalInput += Number(m[1]);
        const processed =
          Number(m[3]) + Number(m[4]) + Number(m[5]) + Number(m[6]) +
          Number(m[7]) + Number(m[8]) + Number(m[9]) + Number(m[10]) +
          Number(m[11]);
        totalProcessed += processed;
      }

      // The fixture has 500+ invalid lookups. With the captain bug, only
      // a small fraction is processed before budget exhausts.
      assert.ok(
        totalInput >= 300,
        `Fixture should produce 300+ phase2-lookup inputs. Got ${totalInput}.\n` +
        `phase2 lines:\n  ${phase2Lines.join('\n  ')}\n` +
        `publish: ${publishLine}\n` +
        `Recent buffer (last 30):\n  ${buf.slice(-30).join('\n  ')}`
      );
      // Always emit a diagnostic dump in the message so debugging is easy.
      const debugDump =
        `partial=${partial} totalInput=${totalInput} totalProcessed=${totalProcessed}\n` +
        `phase2-lookups lines:\n  ${phase2Lines.join('\n  ')}\n` +
        `publish line: ${publishLine}\n` +
        `Last 40 buffer lines:\n  ${buf.slice(-40).join('\n  ')}`;
      assert.ok(
        !partial,
        `phase2-lookups must not exhaust the diagnostic budget on a ` +
        `${totalInput}-input file with ~1200ms BG IPC and a 3s budget.\n` +
        debugDump
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
      delete process.env.DJLS_TEST_RESOLVE_LOOKUP_PATH_DELAY_MS;
      delete process.env.DJLS_TEST_RESOLVE_ORM_MEMBER_DELAY_MS;
    }
  });

  test('captain P2: <Model>.objects resolves when Model exists in workspace code but is absent from current daemon indices', async function () {
    // Captain trace L63/L67/L244/L285 (10+ times per session) repeatedly
    // showed `CompanyQuestionThread.objects#unknown_root`. Earlier captain
    // sessions emitted `[completion:lookup:local:hit] model=zuzu.CompanyQuestionThread fields=29`
    // — proof that the daemon CAN know about this model. But in the latest
    // session every local index lacks it (modelLabelByName,
    // localWorkspaceIndex.modelLabelByName, AND localWorkspaceIndex.models),
    // so the classifier's only honest answer is `unknown_root`.
    //
    // Reproduce: drop `blog.Author` from every local index after the
    // daemon has finished indexing. Then trigger a diagnostic on a fixture
    // that uses `Author.objects.filter(...)`. The user's code is valid
    // Django but our session's daemon "forgot" about Author.
    //
    // Asserts the desired post-fix state — receiver resolves (via async
    // BG IPC retry, or a model-graph fallback, or whatever the eventual
    // fix is). Currently fails because resolution returns undefined and
    // the lookup lands in noRecv.
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    // Force BG `resolveRelationTarget` to return unresolved so the daemon
    // can't quietly rescue the lookup via its Python-side graph after we
    // strip the client-side indices.
    process.env.DJLS_TEST_FORCE_RESOLVE_RELATION_UNRESOLVED = '1';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      const daemon = getActiveDaemonForTesting();
      assert.ok(daemon, 'daemon must be active');

      const blogAuthor = daemon.localWorkspaceIndexForTesting.modelLabelByName.get('Author');
      assert.ok(blogAuthor, 'pre-condition: localWorkspaceIndex must know Author');
      // Drop blog.Author from EVERY local index, mirroring captain's
      // current-session state for CompanyQuestionThread.
      dropModelFromAllIndicesForTesting(daemon, blogAuthor);

      // Verify the captain state is reproduced.
      assert.strictEqual(
        daemon.modelLabelByName.has('Author'), false,
        'reproduce: daemon.modelLabelByName must not have Author'
      );
      assert.strictEqual(
        daemon.localWorkspaceIndexForTesting.modelLabelByName.has('Author'), false,
        'reproduce: localWorkspaceIndex.modelLabelByName must not have Author'
      );
      assert.strictEqual(
        daemon.localWorkspaceIndexForTesting.models.has(blogAuthor), false,
        'reproduce: localWorkspaceIndex.models must not have blog.Author'
      );

      // Open a fixture that uses Author.objects.filter(...).
      await openFixtureDocument(
        fixtureRoot,
        'blog/captain_repro_examples.py'
      );
      const matchesFireForDoc = (line: string): boolean =>
        line.startsWith('[diagnostics:trigger] fire ') &&
        line.endsWith('blog/captain_repro_examples.py');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        15_000
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        25_000
      );

      const buf = getDiagnosticLogBufferForTesting();
      const phaseLines = buf.filter((l) =>
        l.includes('phase2-lookups:') || l.includes('receivers-visible')
      );

      // Extract all noRecv reasons + samples.
      let allReasons = '';
      let allSamples = '';
      for (const line of phaseLines) {
        const r = /noRecvReasons=([^\s]+)/.exec(line);
        if (r) allReasons += r[1] + ',';
        const s = /noRecvSamples=\[([^\]]*)\]/.exec(line);
        if (s) allSamples += s[1] + ' | ';
      }

      // Author.<X> samples must NOT be in noRecv. The desired fix should
      // either re-discover Author via BG IPC or expose a daemon model-graph
      // fallback that finds it. Currently — without the fix — the diagnostic
      // resolution should fail and Author should land in noRecv samples.
      const authorSamples = allSamples
        .split('|')
        .filter((s) => /\bAuthor\b/.test(s));

      // Diagnostic dump so the failure mode is visible.
      const dump =
        `daemon.modelLabelByName.size=${daemon.modelLabelByName.size}\n` +
        `localWorkspaceIndex.modelLabelByName.size=${daemon.localWorkspaceIndexForTesting.modelLabelByName.size}\n` +
        `localWorkspaceIndex.models.size=${daemon.localWorkspaceIndexForTesting.models.size}\n` +
        `daemon.modelLabelByName.has('Author')=${daemon.modelLabelByName.has('Author')}\n` +
        `lwi.modelLabelByName.has('Author')=${daemon.localWorkspaceIndexForTesting.modelLabelByName.has('Author')}\n` +
        `lwi.models.has('${blogAuthor}')=${daemon.localWorkspaceIndexForTesting.models.has(blogAuthor)}\n` +
        `noRecvReasons=${allReasons}\n` +
        `Author samples (${authorSamples.length}):\n  ${authorSamples.join('\n  ')}\n` +
        `All samples:\n  ${allSamples}\n` +
        `Phase lines:\n  ${phaseLines.join('\n  ')}`;

      assert.strictEqual(
        authorSamples.length,
        0,
        `Captain regression: workspace model dropped from all indices + BG ` +
        `forced unresolved, but still referenced in user code must still ` +
        `resolve. Got ${authorSamples.length} Author noRecv samples.\n` +
        dump
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
      delete process.env.DJLS_TEST_FORCE_RESOLVE_RELATION_UNRESOLVED;
    }
  });

  test('captain P3: completion returns items for a model present at Pylance level but missing from daemon surfaceIndex', async function () {
    // Captain trace L207, L233, L336, L343 (etc.) repeatedly show:
    //   [completion:lookup:local:miss] model=db.Company indexSize=1343
    //     surfaceKeys=1318 hasSurfaceEntry=false nameMapped=<none> candidates=[]
    //   [completion:lookup:layer] native-skipped model=db.Company resolved=true items=0 reason=unresolved
    //   [completion:lookup:layer] ipc model=db.Company items=0 resolved=false
    //   [completion:lookup:daemon] model=db.Company rawItems=0
    //   [completion:lookup] prefix="" items=0 truncated=false
    // → user types `Company.objects.filter(<cursor>)`, Pylance tells us the
    // type is `db.Company`, daemon has no `db.Company` entry in surfaceIndex
    // OR localWorkspaceIndex, so completion returns 0 items via OUR
    // extension's path. Completion is effectively dead for that model.
    //
    // Reproduce: drop `blog.Author` from every index AND force BG IPC to
    // return unresolved, then trigger completion via the completion
    // provider for an `Author.objects.filter(<prefix>)` cursor. Check the
    // diagnostic log buffer for the `[completion:lookup]` aggregate line —
    // it shows `items=0` today. Desired: items > 0 via fallback.
    this.timeout(60_000);
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      const daemon = getActiveDaemonForTesting();
      assert.ok(daemon, 'daemon must be active');
      const blogAuthor = daemon.localWorkspaceIndexForTesting.modelLabelByName.get('Author');
      assert.ok(blogAuthor, 'pre-condition: localWorkspaceIndex must know Author');

      // Use the imported-Author fixture so the receiver `Author.objects`
      // CAN resolve to `blog.Author` via import/short-name lookup. We
      // then strip JUST the models entry — mirroring captain where
      // Pylance resolves `Company → db.Company`, our short-name map
      // returns the label, but listLookupPathCompletionsLocal can't find
      // `db.Company` in localWorkspaceIndex.models and returns 0 items.
      const document = await openFixtureDocument(
        fixtureRoot,
        'blog/builtin_model_lookup_examples.py'
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      // Drop ONLY the models map entry — receiver still resolves to
      // blog.Author (short-name map has it), but completion's local
      // lookup misses → ends up returning 0 items.
      daemon.localWorkspaceIndexForTesting.models.delete(blogAuthor);

      const fullText = document.getText();
      // The first `User.objects.filter(` occurrence is inside the
      // fixture's module docstring. Search for the indented code form so
      // we land on the actual call site.
      const needle = '\n    User.objects.filter(';
      const idx = fullText.indexOf(needle);
      assert.ok(idx >= 0, `fixture should contain indented '${needle.trim()}'`);
      const position = document.positionAt(idx + needle.length);
      // Also strip auth.User's models entry — that's the receiver in this
      // fixture.
      const authUser = daemon.localWorkspaceIndexForTesting.modelLabelByName.get('User');
      assert.ok(authUser, 'pre-condition: User must be in lwi.modelLabelByName');
      daemon.localWorkspaceIndexForTesting.models.delete(authUser);

      clearDiagnosticLogBufferForTesting();
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        position,
        '',
        0,
      );
      await delay(200);

      const buf = getDiagnosticLogBufferForTesting();
      const completionLines = buf.filter((l) =>
        l.startsWith('[completion:lookup')
      );
      const aggregateLines = completionLines.filter((l) =>
        /^\[completion:lookup\] prefix=/.test(l)
      );

      assert.ok(
        aggregateLines.length > 0,
        `Completion path should emit at least one [completion:lookup] ` +
        `aggregate line. Got 0.\n` +
        `Completion lines: ${completionLines.join('\n  ')}\n` +
        `Last 30 buffer: ${buf.slice(-30).join('\n  ')}`
      );

      // Captain bug: items=0 in aggregate. After fix, items > 0.
      const zeroItemMatches = aggregateLines.filter((l) =>
        /\bitems=0\b/.test(l)
      );
      assert.strictEqual(
        zeroItemMatches.length,
        0,
        `Captain regression: completion path must return at least some ORM ` +
        `items for <Model>.objects.filter(<cursor>) even when the daemon's ` +
        `localWorkspaceIndex has no entry for the model. Got ${zeroItemMatches.length} ` +
        `aggregate lines with items=0:\n  ${zeroItemMatches.join('\n  ')}\n` +
        `All aggregate lines:\n  ${aggregateLines.join('\n  ')}`
      );
    } finally {
      // (nothing)
    }
  });

  test('captain P2-followup: phantom <Model>.objects manager must skip BG resolveLookupPath IPC', async function () {
    // Captain post-P2 trace (2026-05-12 16:37):
    //   L264: resolveLookupPath(baseModelLabel=CompanyQuestionThread, value=id, method=filter): 336ms
    //   L269: resolveLookupPath(baseModelLabel=CompanyQuestionThread, value=company, method=filter): 336ms
    //   L284: resolveLookupPath(baseModelLabel=CompanyQuestionThread, value=title__startswith, method=get): 6865ms
    //   L280: time budget exhausted (10043ms > 10000ms)
    //
    // P2 phantom synthesis correctly removed the noRecv bucket — but the
    // synthetic receiver's downstream `resolveLookupPath` BG IPC still
    // fired and the daemon spent 7+ seconds confirming it has no record of
    // the phantom label. The phantom is known-fake by definition, so the
    // IPC produces zero useful information AND eats most of the budget.
    //
    // Fix target: receivers synthesized by the P2 phantom path must skip
    // the per-lookup BG IPC entirely. The lookup-ipc-ms perf counter
    // should be ~0 for these contexts.
    this.timeout(60_000);
    process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS = '15000';
    process.env.DJLS_TEST_FORCE_RESOLVE_RELATION_UNRESOLVED = '1';
    process.env.DJLS_TEST_RESOLVE_LOOKUP_PATH_DELAY_MS = '1500';
    try {
      const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
      await setWorkspaceRoot(fixtureRoot);
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        15_000
      );
      clearReceiverAndLookupCachesForTesting();
      clearDiagnosticLogBufferForTesting();

      const daemon = getActiveDaemonForTesting();
      assert.ok(daemon, 'daemon must be active');

      const blogAuthor = daemon.localWorkspaceIndexForTesting.modelLabelByName.get('Author');
      assert.ok(blogAuthor, 'pre-condition: localWorkspaceIndex must know Author');
      dropModelFromAllIndicesForTesting(daemon, blogAuthor);

      await openFixtureDocument(
        fixtureRoot,
        'blog/captain_repro_examples.py'
      );

      const matchesFireForDoc = (line: string): boolean =>
        line.startsWith('[diagnostics:trigger] fire ') &&
        line.endsWith('blog/captain_repro_examples.py');
      await waitForCondition(
        () => getDiagnosticLogBufferForTesting().some(matchesFireForDoc),
        15_000
      );
      await waitForCondition(
        () => getActiveDiagnosticScanRunningCountForTesting() === 0,
        30_000
      );

      const buf = getDiagnosticLogBufferForTesting();
      // The perf summary line we added in P3's logging work surfaces the
      // accumulated BG IPC time. Phantom receivers should NOT contribute
      // to lookup-ipc-ms.
      const perfLines = buf.filter((l) => l.startsWith('[diagnostics:perf]'));
      assert.ok(
        perfLines.length > 0,
        `Test must observe a [diagnostics:perf] summary. Got 0 lines.\n` +
        `Last 30 buffer:\n  ${buf.slice(-30).join('\n  ')}`
      );

      let totalLookupIpcMs = 0;
      const lookupIpcRe = /lookup-ipc-ms=(\d+)/;
      for (const line of perfLines) {
        const m = lookupIpcRe.exec(line);
        if (m) totalLookupIpcMs += Number(m[1]);
      }
      assert.ok(
        totalLookupIpcMs < 500,
        `Phantom receivers must skip BG lookup-path IPC entirely. Captain ` +
        `regression shows 7000+ms wasted on resolveLookupPath calls for ` +
        `synthesized labels the daemon has no record of. ` +
        `Got totalLookupIpcMs=${totalLookupIpcMs}ms.\n` +
        `Perf lines:\n  ${perfLines.join('\n  ')}`
      );
    } finally {
      delete process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS;
      delete process.env.DJLS_TEST_FORCE_RESOLVE_RELATION_UNRESOLVED;
      delete process.env.DJLS_TEST_RESOLVE_LOOKUP_PATH_DELAY_MS;
    }
  });

  test('B-followup: short-name lookup falls back to localWorkspaceIndex.models keys (captain CompanyQuestionThread)', async function () {
    // Captain trace: `CompanyQuestionThread.objects#unknown_root` repeats
    // 10+ times per session. The full label `zuzu.CompanyQuestionThread`
    // IS in localWorkspaceIndex.models (completion's local:hit confirms
    // model=zuzu.CompanyQuestionThread fields=29 etc.), but neither
    // daemon.modelLabelByName nor localWorkspaceIndex.modelLabelByName
    // has the bare name `CompanyQuestionThread` as a key — likely due to a
    // short-name collision or a delta-application ordering corner case in
    // captain. Either way, the helper that diagnostics rely on (
    // `findModelLabelByShortName` / `hasModelByShortName`) must consult
    // the full-label index as a final fallback so receivers like
    // `CompanyQuestionThread.objects` don't permanently land in noRecv.
    this.timeout(15_000);
    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    await setWorkspaceRoot(fixtureRoot);
    await waitForCondition(
      () => getActiveDiagnosticScanRunningCountForTesting() === 0,
      15_000
    );

    const daemon = getActiveDaemonForTesting();
    assert.ok(daemon, 'daemon must be active');

    // Simulate the captain state: remove 'Author' from BOTH short-name maps
    // but keep 'blog.Author' in localWorkspaceIndex.models intact. This
    // mirrors the captain scenario where `zuzu.CompanyQuestionThread` is in
    // the full-label index but not surfaced via either modelLabelByName.
    const fullLabelBefore = daemon.localWorkspaceIndexForTesting.modelLabelByName.get('Author');
    assert.ok(fullLabelBefore, 'pre-condition: localWorkspaceIndex must know Author');
    daemon.modelLabelByName.delete('Author');
    daemon.localWorkspaceIndexForTesting.modelLabelByName.delete('Author');
    assert.ok(
      daemon.localWorkspaceIndexForTesting.models.has(fullLabelBefore),
      'pre-condition: localWorkspaceIndex.models still has the full label'
    );

    try {
      const bucket = classifyNoRecvReasonForTesting(
        daemon,
        'Author.objects.NONEXISTENT',
      );
      assert.ok(
        bucket.startsWith('root_matched:Author'),
        `Classifier must use the full-label index as a fallback when both ` +
        `short-name maps lack the receiver's root identifier. ` +
        `Expected bucket 'root_matched:Author...'; got '${bucket}'.\n` +
        `daemon.modelLabelByName.has('Author')=${daemon.modelLabelByName.has('Author')}\n` +
        `localWorkspaceIndex.modelLabelByName.has('Author')=${daemon.localWorkspaceIndexForTesting.modelLabelByName.has('Author')}\n` +
        `localWorkspaceIndex.models.has('${fullLabelBefore}')=${daemon.localWorkspaceIndexForTesting.models.has(fullLabelBefore)}`
      );
    } finally {
      // Restore so subsequent tests aren't affected.
      daemon.modelLabelByName.set('Author', fullLabelBefore);
      daemon.localWorkspaceIndexForTesting.modelLabelByName.set('Author', fullLabelBefore);
    }
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
    'djangoOrmIntellisense.diagnostics.enabled': true,
    'djangoOrmIntellisense.diagnostics.fullDocument': true,
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
  await retryWorkspaceFolderUpdate(
    () =>
      configuration.update(
        'diagnostics.enabled',
        true,
        vscode.ConfigurationTarget.WorkspaceFolder
      )
  );
  await retryWorkspaceFolderUpdate(
    () =>
      configuration.update(
        'diagnostics.fullDocument',
        true,
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

function locationFilePath(
  definition: vscode.Location | vscode.LocationLink
): string {
  if ('targetUri' in definition) {
    return definition.targetUri.fsPath;
  }
  return definition.uri.fsPath;
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
