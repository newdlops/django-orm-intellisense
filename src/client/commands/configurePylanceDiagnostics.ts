import * as vscode from 'vscode';
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
          'Pylance is not installed. Install the Pylance extension to configure its diagnostics.'
        );
        return;
      }

      const interactive = requestedProfile === undefined;
      const profile = requestedProfile ?? (await pickProfile());
      if (!profile) {
        return;
      }

      try {
        await applyPylanceDiagnosticProfile(profile);

        if (!interactive) {
          return;
        }

        const choice = await vscode.window.showInformationMessage(
          successMessage(profile),
          'Open Settings',
          'Show Status'
        );

        if (choice === 'Open Settings') {
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'python.analysis.diagnosticSeverityOverrides'
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
          `[extension] Configure Pylance Diagnostics command failed: ${message}`
        );

        if (!interactive) {
          throw error;
        }

        const choice = await vscode.window.showErrorMessage(
          `Failed to update Pylance diagnostics: ${message}`,
          'Open Settings',
          'Open Output'
        );

        if (choice === 'Open Settings') {
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'python.analysis.diagnosticSeverityOverrides'
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
        description: 'Downgrade common Django ORM dynamic false positives',
        detail:
          'Keeps likely real issues visible while reducing error-level noise from dynamic model fields, managers, and queryset calls.',
        profile: 'recommended',
      },
      {
        label: 'Suppress',
        description: 'Hide known dynamic ORM false positives',
        detail:
          'Silences the managed Pylance rules entirely for this workspace.',
        profile: 'suppress',
      },
      {
        label: 'Restore',
        description: 'Remove Django ORM Intellisense-managed overrides',
        detail:
          'Leaves any unrelated Pylance diagnostic overrides untouched.',
        profile: 'restore',
      },
    ],
    {
      placeHolder: 'Choose how Django ORM Intellisense should adjust Pylance diagnostics',
      ignoreFocusOut: true,
    }
  );

  return selection?.profile;
}

function successMessage(profile: PylanceDiagnosticProfile): string {
  if (profile === 'restore') {
    return 'Removed Django ORM Intellisense-managed Pylance diagnostic overrides.';
  }

  if (profile === 'suppress') {
    return 'Configured Pylance to suppress the managed dynamic Django ORM diagnostic rules for this workspace.';
  }

  return 'Configured Pylance to downgrade the managed dynamic Django ORM diagnostic rules for this workspace.';
}

function configurationTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}
