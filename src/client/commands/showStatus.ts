import * as vscode from 'vscode';
import { getExtensionSettings } from '../config/settings';
import { AnalysisDaemon } from '../daemon/analysisDaemon';
import type { HealthSnapshot } from '../protocol';

const STATUS_REPORT_SCHEME = 'django-orm-intellisense-status';
const STATUS_REPORT_URI = vscode.Uri.from({
  scheme: STATUS_REPORT_SCHEME,
  path: '/status.md',
});

interface StatusReport {
  markdown: string;
  plainText: string;
}

class StatusReportProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private content = '# Django ORM Intellisense Status\n\nStatus has not been loaded yet.';

  readonly onDidChange = this.onDidChangeEmitter.event;

  update(snapshot: HealthSnapshot): StatusReport {
    const report = buildStatusReport(
      snapshot,
      getExtensionSettings(configurationScopeForSnapshot(snapshot)).pythonInterpreter
    );
    this.content = report.markdown;
    this.onDidChangeEmitter.fire(STATUS_REPORT_URI);
    return report;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.toString() !== STATUS_REPORT_URI.toString()) {
      return 'Status report unavailable.';
    }

    return this.content;
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

function configurationScopeForSnapshot(
  snapshot: HealthSnapshot
): vscode.ConfigurationScope | undefined {
  if (snapshot.workspaceRoot) {
    const workspaceUri = vscode.Uri.file(snapshot.workspaceRoot);
    return vscode.workspace.getWorkspaceFolder(workspaceUri)?.uri ?? workspaceUri;
  }

  return (
    vscode.window.activeTextEditor?.document.uri ??
    vscode.workspace.workspaceFolders?.[0]?.uri
  );
}

function buildStatusReport(
  snapshot: HealthSnapshot,
  configuredInterpreter: string | undefined
): StatusReport {
  const markdownLines = [
    '# Django ORM Intellisense Status',
    '',
    '## Summary',
    '',
    `- State: \`${snapshot.phase}\``,
    `- Detail: ${snapshot.detail}`,
    `- Workspace: \`${snapshot.workspaceRoot ?? 'Unavailable'}\``,
    `- Manage.py: \`${snapshot.managePyPath ?? 'Unavailable'}\``,
    `- Python: \`${snapshot.pythonPath ?? 'Unavailable'}\``,
    `- Python source: \`${snapshot.pythonSource ?? 'Unavailable'}\``,
    `- Settings: \`${snapshot.settingsModule ?? 'Not set'}\``,
  ];

  const plainTextLines = [
    'Django ORM Intellisense Status',
    '',
    `State: ${snapshot.phase}`,
    `Detail: ${snapshot.detail}`,
    `Workspace: ${snapshot.workspaceRoot ?? 'Unavailable'}`,
    `Manage.py: ${snapshot.managePyPath ?? 'Unavailable'}`,
    `Python: ${snapshot.pythonPath ?? 'Unavailable'}`,
    `Python source: ${snapshot.pythonSource ?? 'Unavailable'}`,
    `Settings: ${snapshot.settingsModule ?? 'Not set'}`,
  ];

  markdownLines.push('', '## Interpreter Configuration', '');
  plainTextLines.push('', 'Interpreter Configuration');

  markdownLines.push(
    `- djangoOrmIntellisense.pythonInterpreter: \`${configuredInterpreter ?? 'Not set'}\``
  );
  plainTextLines.push(
    `djangoOrmIntellisense.pythonInterpreter: ${configuredInterpreter ?? 'Not set'}`
  );

  if (snapshot.pythonSourceDetail) {
    markdownLines.push(
      `- Interpreter resolution: ${snapshot.pythonSourceDetail}`
    );
    plainTextLines.push(
      `Interpreter resolution: ${snapshot.pythonSourceDetail}`
    );
  }

  if (snapshot.settingsCandidates && snapshot.settingsCandidates.length > 0) {
    markdownLines.push(
      `- Settings candidates: ${snapshot.settingsCandidates.map((candidate) => `\`${candidate}\``).join(', ')}`
    );
    plainTextLines.push(
      `Settings candidates: ${snapshot.settingsCandidates.join(', ')}`
    );
  }

  if (snapshot.runtime) {
    markdownLines.push('', '## Runtime', '');
    plainTextLines.push('', 'Runtime');

    const djangoStatus = snapshot.runtime.djangoImportable
      ? snapshot.runtime.djangoVersion ?? 'importable'
      : 'not importable';
    markdownLines.push(`- Django: ${djangoStatus}`);
    markdownLines.push(`- Bootstrap: \`${snapshot.runtime.bootstrapStatus}\``);
    plainTextLines.push(`Django: ${djangoStatus}`);
    plainTextLines.push(`Bootstrap: ${snapshot.runtime.bootstrapStatus}`);

    if (snapshot.runtime.modelCount !== undefined) {
      const runtimeSummary = `${snapshot.runtime.appCount ?? 0} apps, ${snapshot.runtime.modelCount} models, ${snapshot.runtime.fieldCount ?? 0} fields, ${snapshot.runtime.relationCount ?? 0} forward relations, ${snapshot.runtime.reverseRelationCount ?? 0} reverse relations`;
      markdownLines.push(`- Runtime ORM: ${runtimeSummary}`);
      plainTextLines.push(`Runtime ORM: ${runtimeSummary}`);
    }

    if (snapshot.runtime.modelPreview && snapshot.runtime.modelPreview.length > 0) {
      const modelPreview = snapshot.runtime.modelPreview
        .map((model) => `\`${model.label}\``)
        .join(', ');
      markdownLines.push(`- Model preview: ${modelPreview}`);
      plainTextLines.push(
        `Model preview: ${snapshot.runtime.modelPreview.map((model) => model.label).join(', ')}`
      );
    }

    if (snapshot.runtime.bootstrapError) {
      markdownLines.push(`- Runtime error: \`${snapshot.runtime.bootstrapError}\``);
      plainTextLines.push(`Runtime error: ${snapshot.runtime.bootstrapError}`);
    }
  }

  markdownLines.push('', '## Static Analysis', '');
  plainTextLines.push('', 'Static Analysis');

  if (snapshot.staticIndex) {
    const staticIndexSummary = `${snapshot.staticIndex.pythonFileCount} files, ${snapshot.staticIndex.reexportModuleCount} re-export surfaces, ${snapshot.staticIndex.modelCandidateCount} model candidates`;
    markdownLines.push(`- Static index: ${staticIndexSummary}`);
    plainTextLines.push(`Static index: ${staticIndexSummary}`);
  }

  if (snapshot.semanticGraph) {
    const semanticGraphSummary = `${snapshot.semanticGraph.coverageMode} (${snapshot.semanticGraph.provenanceLayers.join(', ')})`;
    markdownLines.push(`- Semantic graph: ${semanticGraphSummary}`);
    plainTextLines.push(`Semantic graph: ${semanticGraphSummary}`);
  }

  if (snapshot.pylanceStubs) {
    const pylanceStubSummary = `${snapshot.pylanceStubs.fileCount} files in ${snapshot.pylanceStubs.relativeRoot}`;
    markdownLines.push(`- Pylance stubs: ${pylanceStubSummary}`);
    plainTextLines.push(`Pylance stubs: ${pylanceStubSummary}`);
  }

  const recommendations = buildRecommendations(snapshot, configuredInterpreter);
  if (recommendations.length > 0) {
    markdownLines.push('', '## Next Steps', '');
    plainTextLines.push('', 'Next Steps');
    for (const recommendation of recommendations) {
      markdownLines.push(`- ${recommendation}`);
      plainTextLines.push(`- ${recommendation}`);
    }
  }

  if (snapshot.capabilities.length > 0) {
    markdownLines.push('', '## Capabilities', '');
    plainTextLines.push('', 'Capabilities');
    markdownLines.push(
      snapshot.capabilities.map((capability) => `- \`${capability}\``).join('\n')
    );
    plainTextLines.push(...snapshot.capabilities.map((capability) => `- ${capability}`));
  }

  return {
    markdown: markdownLines.join('\n'),
    plainText: plainTextLines.join('\n'),
  };
}

function buildRecommendations(
  snapshot: HealthSnapshot,
  configuredInterpreter: string | undefined
): string[] {
  const recommendations: string[] = [];
  const runtime = snapshot.runtime;

  if (!configuredInterpreter) {
    recommendations.push(
      'Run "Django ORM Intellisense: Select Python Interpreter" and set `djangoOrmIntellisense.pythonInterpreter` for this workspace.'
    );
  }

  if (!runtime) {
    return recommendations;
  }

  if (!runtime.djangoImportable) {
    recommendations.push(
      'Point `djangoOrmIntellisense.pythonInterpreter` at an environment that has Django installed, or install Django into the selected interpreter.'
    );

    if (snapshot.pythonSource === 'fallback') {
      recommendations.push(
        'The extension is running on its fallback interpreter because no explicit interpreter is configured.'
      );
    }
  }

  if (snapshot.phase === 'error' && snapshot.detail.includes('timed out')) {
    recommendations.push(
      'Initialization timed out. Check the selected interpreter, workspace root, and settings module first, then inspect the Output panel for a stalled bootstrap step.'
    );
  }

  if (runtime.bootstrapStatus === 'skipped_missing_settings') {
    recommendations.push(
      snapshot.settingsCandidates && snapshot.settingsCandidates.length > 0
        ? 'Choose one of the discovered settings modules with "Django ORM Intellisense: Select Settings Module".'
        : 'Set `djangoOrmIntellisense.settingsModule` so runtime ORM inspection can run.'
    );
  }

  if (runtime.bootstrapStatus === 'setup_failed') {
    recommendations.push(
      'Open the Output panel and inspect the bootstrap error. This usually means the settings module imports failed or required environment variables are missing.'
    );
  }

  if (snapshot.phase === 'degraded' && snapshot.managePyPath) {
    recommendations.push(
      'Static-only analysis is still active, so string-based model and lookup indexing should continue to work while runtime inspection is unavailable.'
    );
  }

  return [...new Set(recommendations)];
}

async function openStatusReport(
  snapshot: HealthSnapshot,
  output: vscode.OutputChannel,
  provider: StatusReportProvider
): Promise<void> {
  const report = provider.update(snapshot);
  output.clear();
  output.append(report.plainText);

  const rawDocument = await vscode.workspace.openTextDocument(STATUS_REPORT_URI);
  const document =
    rawDocument.languageId === 'markdown'
      ? rawDocument
      : await vscode.languages.setTextDocumentLanguage(rawDocument, 'markdown');

  await vscode.window.showTextDocument(document, {
    preview: true,
    preserveFocus: false,
  });
}

export function registerShowStatusCommand(
  daemon: AnalysisDaemon,
  output: vscode.OutputChannel
): vscode.Disposable {
  const provider = new StatusReportProvider();
  const providerRegistration = vscode.workspace.registerTextDocumentContentProvider(
    STATUS_REPORT_SCHEME,
    provider
  );
  const commandRegistration = vscode.commands.registerCommand(
    'djangoOrmIntellisense.showStatus',
    async () => {
      let snapshot = daemon.getState();

      try {
        snapshot =
          snapshot.phase === 'stopped' ? await daemon.start() : await daemon.refreshHealth();
      } catch {
        snapshot = daemon.getState();
      }

      await openStatusReport(snapshot, output, provider);
      const prompt =
        snapshot.phase === 'error'
          ? vscode.window.showErrorMessage
          : snapshot.phase === 'degraded'
            ? vscode.window.showWarningMessage
            : vscode.window.showInformationMessage;

      const choice = await prompt(
        'Opened the Django ORM Intellisense status report.',
        'Select Interpreter',
        'Select Settings',
        'Open Output',
        'Restart Daemon',
        'Configure Pylance'
      );

      if (choice === 'Select Interpreter') {
        await vscode.commands.executeCommand(
          'djangoOrmIntellisense.selectPythonInterpreter'
        );
        return;
      }

      if (choice === 'Select Settings') {
        await vscode.commands.executeCommand(
          'djangoOrmIntellisense.selectSettingsModule'
        );
        return;
      }

      if (choice === 'Open Output') {
        output.show(true);
        return;
      }

      if (choice === 'Restart Daemon') {
        await daemon.restart();
        return;
      }

      if (choice === 'Configure Pylance') {
        await vscode.commands.executeCommand(
          'djangoOrmIntellisense.configurePylanceDiagnostics'
        );
      }
    }
  );

  return vscode.Disposable.from(providerRegistration, provider, commandRegistration);
}
