import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { HealthSnapshot } from '../client/protocol';
import { syncManagedPylanceStubPath } from '../client/pylance/stubPath';
import {
  resolvePythonInterpreter,
  savePythonInterpreterSetting,
  validatePythonInterpreterPath,
} from '../client/python/interpreter';

const EXTENSION_ID = 'newdlops.django-orm-intellisense';

suite('Django ORM Intellisense UI', () => {
  suiteSetup(async () => {
    await setPythonInterpreter(defaultTestInterpreter());
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension ${EXTENSION_ID} is not available.`);
    await extension.activate();
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
    assert.ok(
      hasCompletionItemLabel(completionList.items, 'profile__timezone'),
      'Expected lookup path completion to include chained lookup suggestions.'
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
    const chainedCompletionItem = findCompletionItemByLabel(
      completionList.items,
      'profile__timezone'
    );
    assert.strictEqual(
      chainedCompletionItem?.insertText,
      'profile__timezone',
      'Expected string lookup chained completion to insert the full lookup path.'
    );
    assert.strictEqual(
      completionItemFilterValue(chainedCompletionItem!),
      'profile__timezone',
      'Expected string lookup chained completion to match its visible chained label.'
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
    assert.strictEqual(lookupDefinition.range.start.line + 1, 38);
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
      70,
      'Expected reverse lookup definition to target the CorporateRegistration.registration_code field.'
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) => item.message.includes('author__unknown'))
    );
    assert.ok(
      diagnostics.every(
        (item) => !item.message.includes('corporate_registration__registration_code')
      ),
      `Expected runtime-backed reverse lookup path to avoid diagnostics. Received: ${stringifyDiagnostics(diagnostics)}`
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
      62,
      'Expected foreign-key attname definition to target the Post.author field.'
    );

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) =>
        items.some((item) => item.message.includes('author__unknown'))
    );
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
      hasCompletionItemLabel(blankCompletionList?.items, 'title__endswith'),
      'Expected empty keyword completion to include `title__endswith`.'
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
    const stringChainedItem = findCompletionItemByLabel(
      stringCompletionList?.items,
      'profile__timezone'
    );

    assert.ok(stringFieldItem, 'Expected string lookup completion to include `profile`.');
    assert.ok(
      completionItemFilterValue(stringFieldItem!).startsWith('pro'),
      `Expected string lookup field completion to filter by the visible segment. Received: ${completionItemFilterValue(stringFieldItem!)}`
    );
    assert.ok(
      stringChainedItem,
      'Expected string lookup completion to include `profile__timezone`.'
    );
    assert.ok(
      completionItemFilterValue(stringChainedItem!).startsWith('pro'),
      `Expected string lookup chained completion to filter by the visible segment. Received: ${completionItemFilterValue(stringChainedItem!)}`
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
    assert.ok(
      completionItemFilterValue(keywordFieldItem!).startsWith('pro'),
      `Expected keyword lookup field completion to filter by the visible segment. Received: ${completionItemFilterValue(keywordFieldItem!)}`
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
      completionItemFilterValue(operatorItem!).startsWith('i'),
      `Expected nested operator completion to filter by the operator segment. Received: ${completionItemFilterValue(operatorItem!)}`
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
    assert.ok(
      hasCompletionItemLabel(fieldCompletionList?.items, 'profile__timezone'),
      'Expected keyword lookup completion to include chained lookup suggestions.'
    );
    const fieldCompletionItem = findCompletionItemByLabel(
      fieldCompletionList?.items,
      'profile'
    );
    assert.strictEqual(
      completionItemFilterValue(fieldCompletionItem!),
      'profile',
      'Expected keyword lookup field completion to match its visible label.'
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
    const chainedFieldCompletionItem = findCompletionItemByLabel(
      fieldCompletionList?.items,
      'profile__timezone'
    );
    assert.strictEqual(
      completionItemFilterValue(chainedFieldCompletionItem!),
      'profile__timezone',
      'Expected keyword lookup chained completion to match its visible chained label.'
    );
    assert.strictEqual(
      chainedFieldCompletionItem?.insertText,
      'profile__timezone__',
      'Expected keyword lookup chained completion to continue lookup operators.'
    );
    assert.strictEqual(
      chainedFieldCompletionItem?.command?.command,
      'editor.action.triggerSuggest',
      'Expected keyword lookup chained completion to reopen suggestions.'
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
      'icontains',
      'Expected keyword lookup operator completion to match its visible operator label.'
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
      38,
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
      completionItemDisplayLabel(auditLogNameCompletionItem!),
      'name (CharField)',
      'Expected inherited-instance field completion to show the Django field kind inline in the suggestion label.'
    );
    assert.strictEqual(
      completionItemDescription(auditLogNameCompletionItem!),
      'Django model',
      'Expected inherited-instance field completion to be marked as a Django model suggestion.'
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
      'slug',
      'Expected queryset variable field completion to match its visible label.'
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

    const blankInstanceLabels = (blankInstanceCompletionList?.items ?? []).map((item) =>
      completionItemLabel(item)
    );
    assert.deepStrictEqual(
      blankInstanceLabels.slice(0, 3),
      ['category', 'name', 'is_active'],
      `Expected instance receiver completions to keep Django fields at the top. Received: ${blankInstanceLabels
        .slice(0, 10)
        .join(', ')}`
    );
    const nameCompletionItem = findCompletionItemByLabel(
      blankInstanceCompletionList?.items,
      'name'
    );
    assert.strictEqual(
      completionItemDisplayLabel(nameCompletionItem!),
      'name (CharField)',
      'Expected instance receiver completions to expose the Django field kind inline.'
    );
    assert.strictEqual(
      completionItemDescription(nameCompletionItem!),
      'Django model',
      'Expected instance receiver completions to be marked as Django model suggestions.'
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
    const blankInstanceLabels = (blankInstanceCompletionList?.items ?? []).map((item) =>
      completionItemLabel(item)
    );
    assert.ok(
      blankInstanceLabels.slice(0, 5).includes('name'),
      `Expected model fields to be prioritized when completing after \`instance.\`. Received: ${blankInstanceLabels
        .slice(0, 10)
        .join(', ')}`
    );
    assert.ok(
      blankInstanceLabels.slice(0, 5).includes('category'),
      `Expected relation fields to be prioritized when completing after \`instance.\`. Received: ${blankInstanceLabels
        .slice(0, 10)
        .join(', ')}`
    );
    assert.deepStrictEqual(
      blankInstanceLabels.slice(0, 3),
      ['category', 'name', 'is_active'],
      `Expected Django model fields to occupy the first completion slots after \`instance.\`. Received: ${blankInstanceLabels
        .slice(0, 10)
        .join(', ')}`
    );

    const blankNameCompletionItem = findCompletionItemByLabel(
      blankInstanceCompletionList?.items,
      'name'
    );
    assert.strictEqual(
      completionItemDisplayLabel(blankNameCompletionItem!),
      'name (CharField)',
      'Expected blank model instance suggestions to expose the Django field kind inline in the suggestion label.'
    );
    assert.strictEqual(
      completionItemDescription(blankNameCompletionItem!),
      'Django model',
      'Expected blank model instance suggestions to be marked as Django model completions.'
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
    const instanceCompletionLabels = (instanceCompletionList?.items ?? []).map((item) =>
      completionItemLabel(item)
    );
    assert.ok(
      instanceCompletionLabels.slice(0, 4).includes('name'),
      `Expected model instance fields to appear near the top of completion results. Received: ${instanceCompletionLabels
        .slice(0, 8)
        .join(', ')}`
    );
    assert.ok(
      instanceCompletionLabels.slice(0, 4).includes('category'),
      `Expected relation fields to remain near the top of model instance completions. Received: ${instanceCompletionLabels
        .slice(0, 8)
        .join(', ')}`
    );

    const nameCompletionItem = findCompletionItemByLabel(
      instanceCompletionList?.items,
      'name'
    );
    assert.strictEqual(
      completionItemDisplayLabel(nameCompletionItem!),
      'name (CharField)',
      'Expected model instance field completions to expose the Django field kind inline in the suggestion label.'
    );
    assert.strictEqual(
      completionItemDescription(nameCompletionItem!),
      'Django model',
      'Expected model instance field completions to be labeled as Django model suggestions.'
    );
    assert.ok(
      nameCompletionItem?.detail?.startsWith('Django model field · CharField'),
      `Expected model instance field detail to describe a Django model field. Received: ${nameCompletionItem?.detail}`
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
  });

  test('infers loop target receivers from querysets and typed collections', async function () {
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
      await vscode.workspace
        .getConfiguration('djangoOrmIntellisense', vscode.Uri.file(tempWorkspace))
        .update(
          'pythonInterpreter',
          undefined,
          vscode.ConfigurationTarget.WorkspaceFolder
        );
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
      await vscode.workspace
        .getConfiguration('djangoOrmIntellisense', vscode.Uri.file(tempWorkspace))
        .update(
          'pythonInterpreter',
          undefined,
          vscode.ConfigurationTarget.WorkspaceFolder
        );
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

  test('configures managed Pylance stubPath and extraPaths when stubs are available', async function () {
    this.timeout(20_000);

    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'django-orm-intellisense-managed-stubs-')
    );
    const tempWorkspace = path.join(tempRoot, 'workspace');
    const stubRoot = path.join(tempWorkspace, '.django_orm_intellisense', 'stubs');
    fs.mkdirSync(stubRoot, { recursive: true });

    await removeWorkspaceFoldersFrom(0);
    await addWorkspaceFolder(tempWorkspace);

    try {
      writeWorkspaceSettings(tempWorkspace, {
        'python.analysis.extraPaths': ['src'],
      });

      const snapshot: HealthSnapshot = {
        phase: 'ready',
        detail: 'stub sync test',
        capabilities: ['pylance.stubs'],
        workspaceRoot: tempWorkspace,
        pylanceStubs: {
          rootPath: stubRoot,
          relativeRoot: '.django_orm_intellisense/stubs',
          fileCount: 2,
          moduleCount: 1,
          packageCount: 1,
          generatedAt: new Date().toISOString(),
        },
      };
      const output = vscode.window.createOutputChannel(
        'Django ORM Intellisense Test'
      );

      try {
        await syncManagedPylanceStubPath(snapshot, output);
      } finally {
        output.dispose();
      }

      const settings = readWorkspaceSettings(tempWorkspace);
      assert.strictEqual(
        settings['python.analysis.stubPath'],
        '.django_orm_intellisense/stubs'
      );
      assert.deepStrictEqual(settings['python.analysis.extraPaths'], [
        '.django_orm_intellisense/stubs',
        'src',
      ]);
    } finally {
      await removeWorkspaceFoldersFrom(0);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('removes legacy managed Pylance stubPath and stub files when stub generation is disabled', async function () {
    this.timeout(20_000);

    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'django-orm-intellisense-stub-workspace-')
    );
    const tempWorkspace = path.join(tempRoot, 'workspace');
    fs.mkdirSync(tempWorkspace, { recursive: true });
    const legacyStubRoot = path.join(
      tempWorkspace,
      '.django_orm_intellisense',
      'stubs'
    );
    fs.mkdirSync(path.join(legacyStubRoot, 'blog'), { recursive: true });
    fs.writeFileSync(path.join(legacyStubRoot, '.stub-version'), '2\n', 'utf8');
    fs.writeFileSync(
      path.join(legacyStubRoot, '_django_orm_intellisense_support.pyi'),
      'class DjangoQuerySet: ...\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(legacyStubRoot, 'blog', 'models.pyi'),
      'class Post: ...\n',
      'utf8'
    );

    await removeWorkspaceFoldersFrom(0);
    await addWorkspaceFolder(tempWorkspace);

    try {
      writeWorkspaceSettings(tempWorkspace, {
        'python.analysis.stubPath': '.django_orm_intellisense/stubs',
        'python.analysis.extraPaths': [
          '.django_orm_intellisense/stubs',
          'src',
        ],
      });

      const snapshot: HealthSnapshot = {
        phase: 'ready',
        detail: 'stub sync test',
        capabilities: [],
        workspaceRoot: tempWorkspace,
      };
      const output = vscode.window.createOutputChannel(
        'Django ORM Intellisense Test'
      );

      try {
        await syncManagedPylanceStubPath(snapshot, output);
      } finally {
        output.dispose();
      }

      const managedStubPath = readWorkspaceSettings(tempWorkspace)[
        'python.analysis.stubPath'
      ];
      const managedExtraPaths = readWorkspaceSettings(tempWorkspace)[
        'python.analysis.extraPaths'
      ];

      assert.strictEqual(
        managedStubPath,
        undefined,
        'Expected the legacy managed python.analysis.stubPath to be removed.'
      );
      assert.deepStrictEqual(
        managedExtraPaths,
        ['src'],
        'Expected only the managed extraPaths entry to be removed.'
      );
      assert.ok(
        !fs.existsSync(legacyStubRoot),
        'Expected the legacy managed stub files to be removed.'
      );
      assert.ok(
        !fs.existsSync(path.join(tempWorkspace, '.django_orm_intellisense')),
        'Expected the empty legacy managed stub directory to be removed.'
      );
    } finally {
      await removeWorkspaceFoldersFrom(0);
      fs.rmSync(tempRoot, { recursive: true, force: true });
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
});

async function setWorkspaceRoot(rootPath: string): Promise<void> {
  await vscode.workspace
    .getConfiguration('djangoOrmIntellisense', extensionConfigurationScope())
    .update(
      'workspaceRoot',
      rootPath,
      configurationTarget()
    );
  await delay(1200);
}

async function setPythonInterpreter(interpreter: string): Promise<void> {
  await vscode.workspace
    .getConfiguration('djangoOrmIntellisense', extensionConfigurationScope())
    .update(
      'pythonInterpreter',
      interpreter,
      configurationTarget()
    );
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
  const updated = vscode.workspace.updateWorkspaceFolders(
    0,
    0,
    {
      uri: vscode.Uri.file(rootPath),
      name: path.basename(rootPath),
    }
  );
  assert.ok(updated, `Failed to add workspace folder: ${rootPath}`);
  await delay(500);
}

async function removeWorkspaceFoldersFrom(startIndex: number): Promise<void> {
  const currentCount = vscode.workspace.workspaceFolders?.length ?? 0;
  if (currentCount <= startIndex) {
    return;
  }

  const updated = vscode.workspace.updateWorkspaceFolders(
    startIndex,
    currentCount - startIndex
  );
  assert.ok(updated, 'Failed to remove temporary workspace folders.');
  await delay(500);
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
