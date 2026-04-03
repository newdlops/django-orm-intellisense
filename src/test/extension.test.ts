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
    await setPythonInterpreter('');
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
      !hasCompletionItemLabel(completionList.items, 'profile__timezone'),
      'Expected lookup path completion to suggest only the next lookup segment.'
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
    assert.strictEqual(lookupDefinition.range.start.line + 1, 37);
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
      !hasCompletionItemLabel(fieldCompletionList?.items, 'profile__timezone'),
      'Expected keyword lookup completion to suggest only the next lookup segment.'
    );
    const fieldCompletionItem = findCompletionItemByLabel(
      fieldCompletionList?.items,
      'profile'
    );
    assert.strictEqual(
      fieldCompletionItem?.filterText,
      'author__profile',
      'Expected keyword lookup field completion to use the full lookup path as filterText.'
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
      37,
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

  test('generates managed Pylance stubs and wires stubPath for the workspace', async function () {
    this.timeout(30_000);

    const tempWorkspace = fs.mkdtempSync(
      path.join(os.tmpdir(), 'django-orm-intellisense-stubs-')
    );
    const fixtureRoot = path.resolve(__dirname, '../../fixtures/minimal_project');
    fs.cpSync(fixtureRoot, tempWorkspace, { recursive: true });

    await removeWorkspaceFoldersFrom(0);
    await addWorkspaceFolder(tempWorkspace);
    await setWorkspaceRoot(tempWorkspace);
    await setPythonInterpreter('');

    try {
      const stubRoot = path.join(
        tempWorkspace,
        '.django_orm_intellisense',
        'stubs'
      );
      const modelStubPath = path.join(stubRoot, 'blog', 'models.pyi');
      const supportStubPath = path.join(
        stubRoot,
        '_django_orm_intellisense_support.pyi'
      );
      const versionFilePath = path.join(stubRoot, '.stub-version');

      await waitForCondition(() => {
        const settings = readWorkspaceSettings(tempWorkspace);
        return (
          settings['python.analysis.stubPath'] ===
            '.django_orm_intellisense/stubs' &&
          fs.existsSync(modelStubPath) &&
          fs.existsSync(supportStubPath) &&
          fs.existsSync(versionFilePath)
        );
      }, 20_000);

      const settings = readWorkspaceSettings(tempWorkspace);
      assert.strictEqual(
        settings['python.analysis.stubPath'],
        '.django_orm_intellisense/stubs'
      );

      const modelStub = fs.readFileSync(modelStubPath, 'utf8');
      assert.ok(
        modelStub.includes('class Post(models.Model):'),
        `Expected generated model stub to include Post. Received: ${modelStub}`
      );
      assert.ok(
        modelStub.includes('objects: ClassVar[DjangoManager[Post]]'),
        `Expected generated model stub to include a typed manager. Received: ${modelStub}`
      );
      assert.ok(
        modelStub.includes('author: Author'),
        `Expected generated model stub to type ForeignKey relations. Received: ${modelStub}`
      );
      assert.ok(
        modelStub.includes('class AuditLog(TimeStampedBaseModel):'),
        `Expected inherited model stub to preserve base classes. Received: ${modelStub}`
      );
      assert.ok(
        fs.existsSync(path.join(stubRoot, 'blog', 'py.typed')),
        'Expected generated stubs to include py.typed for the top-level package.'
      );
      assert.ok(
        fs.readFileSync(versionFilePath, 'utf8').trim().length > 0,
        'Expected generated stubs to include a stub schema version marker.'
      );
    } finally {
      await removeWorkspaceFoldersFrom(0);
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });
});

async function setWorkspaceRoot(rootPath: string): Promise<void> {
  await vscode.workspace
    .getConfiguration('djangoOrmIntellisense')
    .update(
      'workspaceRoot',
      rootPath,
      configurationTarget()
    );
  await delay(1200);
}

async function setPythonInterpreter(interpreter: string): Promise<void> {
  await vscode.workspace
    .getConfiguration('djangoOrmIntellisense')
    .update(
      'pythonInterpreter',
      interpreter,
      configurationTarget()
    );
  await delay(1200);
}

function configurationTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function defaultTestInterpreter(): string {
  if (process.platform === 'win32') {
    return 'python';
  }

  return fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
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
  return typeof item.label === 'string' ? item.label : item.label.label;
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
