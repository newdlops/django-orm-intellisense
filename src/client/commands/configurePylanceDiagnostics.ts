import * as vscode from 'vscode';
import {
  applyStubOverrides,
  revertStubOverrides,
  STUB_OVERRIDE_RELATIVE_PATH,
  type ApplyStubOverrideResult,
  type RevertStubOverrideResult,
} from '../pylance/stubOverrides';
import { isPylanceAvailable } from '../python/pylance';
import {
  readWorkspaceSettingValue,
  writeWorkspaceSettingValue,
} from '../settings/workspaceJsonSettings';

type PylanceDiagnosticProfile = 'recommended' | 'suppress' | 'restore';
type DiagnosticSeverityOverride =
  | 'error'
  | 'warning'
  | 'information'
  | 'none';

const MANAGED_RULES = [
  'reportAttributeAccessIssue',
  'reportCallIssue',
  'reportUnknownArgumentType',
  'reportUnknownMemberType',
  'reportUnknownParameterType',
  'reportUnknownVariableType',
] as const;

const PROFILE_OVERRIDES: Record<
  Exclude<PylanceDiagnosticProfile, 'restore'>,
  Record<(typeof MANAGED_RULES)[number], DiagnosticSeverityOverride>
> = {
  recommended: {
    reportAttributeAccessIssue: 'warning',
    reportCallIssue: 'warning',
    reportUnknownArgumentType: 'information',
    reportUnknownMemberType: 'information',
    reportUnknownParameterType: 'information',
    reportUnknownVariableType: 'information',
  },
  suppress: {
    reportAttributeAccessIssue: 'none',
    reportCallIssue: 'none',
    reportUnknownArgumentType: 'none',
    reportUnknownMemberType: 'none',
    reportUnknownParameterType: 'none',
    reportUnknownVariableType: 'none',
  },
};

interface ProfileQuickPickItem extends vscode.QuickPickItem {
  profile: PylanceDiagnosticProfile;
}

export function registerConfigurePylanceDiagnosticsCommand(
  output: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'djangoOrmIntellisense.configurePylanceDiagnostics',
    async (requestedProfile?: PylanceDiagnosticProfile) => {
      if (!isPylanceAvailable()) {
        if (requestedProfile !== undefined) {
          return;
        }

        await vscode.window.showWarningMessage(
          'Pylance is not installed. Install the Pylance extension (or another Pyright-based type checker) to override its default Django stubs.'
        );
        return;
      }

      const interactive = requestedProfile === undefined;
      const profile = requestedProfile ?? (await pickProfile());
      if (!profile) {
        return;
      }

      try {
        const stubOutcome = await applyStubOverridesForProfile(profile, output);
        await applyPylanceDiagnosticProfile(profile);

        if (!interactive) {
          return;
        }

        const choice = await vscode.window.showInformationMessage(
          successMessage(profile, stubOutcome),
          'Open Settings',
          'Show Status'
        );

        if (choice === 'Open Settings') {
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'python.analysis.stubPath'
          );
          return;
        }

        if (choice === 'Show Status') {
          await vscode.commands.executeCommand(
            'djangoOrmIntellisense.showStatus'
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(
          `[extension] Override Default Stubs command failed: ${message}`
        );

        if (!interactive) {
          throw error;
        }

        const choice = await vscode.window.showErrorMessage(
          `Failed to override default Django stubs: ${message}`,
          'Open Settings',
          'Open Output'
        );

        if (choice === 'Open Settings') {
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'python.analysis.stubPath'
          );
          return;
        }

        if (choice === 'Open Output') {
          output.show(true);
        }
      }
    }
  );
}

type StubOverrideOutcome =
  | { kind: 'applied'; result: ApplyStubOverrideResult }
  | { kind: 'reverted'; result: RevertStubOverrideResult }
  | { kind: 'skipped' };

async function applyStubOverridesForProfile(
  profile: PylanceDiagnosticProfile,
  output: vscode.OutputChannel
): Promise<StubOverrideOutcome> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return { kind: 'skipped' };
  }

  if (profile === 'restore') {
    const result = await revertStubOverrides(output);
    if (!result) {
      return { kind: 'skipped' };
    }
    return { kind: 'reverted', result };
  }

  const result = await applyStubOverrides(output);
  if (!result) {
    return { kind: 'skipped' };
  }
  return { kind: 'applied', result };
}

async function applyPylanceDiagnosticProfile(
  profile: PylanceDiagnosticProfile
): Promise<void> {
  const target = configurationTarget();
  const currentOverrides =
    target === vscode.ConfigurationTarget.Workspace
      ? ((await readWorkspaceSettingValue(
          'python.analysis.diagnosticSeverityOverrides'
        )) as Record<string, DiagnosticSeverityOverride> | undefined) ?? {}
      : (
          vscode.workspace
            .getConfiguration('python')
            .get<Record<string, DiagnosticSeverityOverride>>(
              'analysis.diagnosticSeverityOverrides'
            ) ?? {}
        );

  const nextOverrides = { ...currentOverrides };
  for (const rule of MANAGED_RULES) {
    delete nextOverrides[rule];
  }

  if (profile !== 'restore') {
    Object.assign(nextOverrides, PROFILE_OVERRIDES[profile]);
  }

  const nextValue =
    Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined;

  if (target === vscode.ConfigurationTarget.Workspace) {
    await writeWorkspaceSettingValue(
      'python.analysis.diagnosticSeverityOverrides',
      nextValue
    );
    return;
  }

  await vscode.workspace.getConfiguration('python').update(
    'analysis.diagnosticSeverityOverrides',
    nextValue,
    target
  );
}

async function pickProfile(): Promise<PylanceDiagnosticProfile | undefined> {
  const selection = await vscode.window.showQuickPick<ProfileQuickPickItem>(
    [
      {
        label: 'Recommended',
        description:
          'Inject partial stub overrides and downgrade remaining dynamic false positives',
        detail:
          `Writes partial stubs under ${STUB_OVERRIDE_RELATIVE_PATH} that replace Model / Manager / QuerySet surfaces bundled with Pylance / Python Extension / Pyright / basedpyright, sets python.analysis.stubPath + basedpyright.analysis.stubPath to that directory, and downgrades error-level noise from dynamic ORM access.`,
        profile: 'recommended',
      },
      {
        label: 'Suppress',
        description:
          'Inject partial stub overrides and silence dynamic ORM diagnostics',
        detail:
          `Writes the same partial stub overrides and silences the managed type-checker rules entirely for this workspace.`,
        profile: 'suppress',
      },
      {
        label: 'Restore',
        description:
          'Remove Django ORM Intellisense-managed stub overrides and diagnostics',
        detail:
          `Deletes ${STUB_OVERRIDE_RELATIVE_PATH}, clears python.analysis.stubPath / basedpyright.analysis.stubPath when they point at that directory, and drops the managed diagnostic overrides.`,
        profile: 'restore',
      },
    ],
    {
      placeHolder:
        'Choose how Django ORM Intellisense should override default Django stubs across Pylance / Python Extension / Pyright / basedpyright',
      ignoreFocusOut: true,
    }
  );

  return selection?.profile;
}

function successMessage(
  profile: PylanceDiagnosticProfile,
  stubOutcome: StubOverrideOutcome
): string {
  if (profile === 'restore') {
    const summary = summarizeRevert(stubOutcome);
    if (summary) {
      return `${summary} Cleared the managed diagnostic overrides.`;
    }
    return 'Cleared the managed diagnostic overrides. No stub overrides were present to remove.';
  }

  const stubDescription = describeApply(stubOutcome);
  if (profile === 'suppress') {
    return `${stubDescription} Suppressed the managed dynamic Django ORM diagnostic rules for this workspace.`;
  }

  return `${stubDescription} Downgraded the managed dynamic Django ORM diagnostic rules for this workspace.`;
}

function describeApply(outcome: StubOverrideOutcome): string {
  if (outcome.kind !== 'applied') {
    return 'Did not write stub overrides (no workspace folder open).';
  }

  const settingsTouched = outcome.result.stubPathUpdates.size;
  const fileCount = outcome.result.writtenFiles.length;
  const settingsNote =
    settingsTouched > 0
      ? `Pointed ${settingsTouched} stubPath setting(s) at the override directory.`
      : 'stubPath settings were already pointing at the override directory.';

  return `Generated ${fileCount} stub file(s) under ${STUB_OVERRIDE_RELATIVE_PATH}. ${settingsNote}`;
}

function summarizeRevert(outcome: StubOverrideOutcome): string | undefined {
  if (outcome.kind !== 'reverted') {
    return undefined;
  }

  const parts: string[] = [];
  if (outcome.result.directoryRemoved) {
    parts.push(`Removed ${STUB_OVERRIDE_RELATIVE_PATH}`);
  }
  if (outcome.result.stubPathReverts.length > 0) {
    parts.push(
      `cleared ${outcome.result.stubPathReverts.join(' and ')}`
    );
  }

  if (parts.length === 0) {
    return undefined;
  }
  return `${parts.join('; ')}.`;
}

function configurationTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}
