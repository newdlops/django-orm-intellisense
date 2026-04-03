import * as vscode from 'vscode';

export async function readWorkspaceSettingValue(
  settingKey: string,
  workspaceFolder: vscode.WorkspaceFolder | undefined = vscode.workspace.workspaceFolders?.[0]
): Promise<unknown> {
  if (!workspaceFolder) {
    return undefined;
  }

  const settingsUri = workspaceSettingsUri(workspaceFolder);

  try {
    const rawContent = await vscode.workspace.fs.readFile(settingsUri);
    const settings = parseJsoncObject(Buffer.from(rawContent).toString('utf8'));
    return settings[settingKey];
  } catch (error) {
    if (error instanceof vscode.FileSystemError) {
      return undefined;
    }
    throw error;
  }
}

export async function writeWorkspaceSettingValue(
  settingKey: string,
  value: unknown,
  workspaceFolder: vscode.WorkspaceFolder | undefined = vscode.workspace.workspaceFolders?.[0]
): Promise<void> {
  if (!workspaceFolder) {
    throw new Error(
      `No workspace folder is open, so ${settingKey} could not be written.`
    );
  }

  const settingsDirectory = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode');
  const settingsUri = workspaceSettingsUri(workspaceFolder);
  await vscode.workspace.fs.createDirectory(settingsDirectory);

  let settings: Record<string, unknown> = {};
  try {
    const rawContent = await vscode.workspace.fs.readFile(settingsUri);
    settings = parseJsoncObject(Buffer.from(rawContent).toString('utf8'));
  } catch (error) {
    if (!(error instanceof vscode.FileSystemError)) {
      throw error;
    }
  }

  if (value === undefined) {
    delete settings[settingKey];
  } else {
    settings[settingKey] = value;
  }

  await vscode.workspace.fs.writeFile(
    settingsUri,
    Buffer.from(`${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  );
}

function workspaceSettingsUri(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'settings.json');
}

function parseJsoncObject(content: string): Record<string, unknown> {
  const stripped = stripTrailingCommas(stripJsonComments(content)).trim();
  if (!stripped) {
    return {};
  }

  const parsed = JSON.parse(stripped) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Workspace settings must contain a JSON object.');
  }

  return parsed as Record<string, unknown>;
}

function stripJsonComments(content: string): string {
  let result = '';
  let inString = false;
  let isEscaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < content.length; index += 1) {
    const current = content[index];
    const next = content[index + 1];

    if (inLineComment) {
      if (current === '\n') {
        inLineComment = false;
        result += current;
      }
      continue;
    }

    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      result += current;
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (current === '\\') {
        isEscaped = true;
        continue;
      }

      if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (current === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (current === '"') {
      inString = true;
    }

    result += current;
  }

  return result;
}

function stripTrailingCommas(content: string): string {
  let result = '';
  let inString = false;
  let isEscaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const current = content[index];

    if (inString) {
      result += current;
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (current === '\\') {
        isEscaped = true;
        continue;
      }

      if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }

    if (current !== ',') {
      result += current;
      continue;
    }

    let lookahead = index + 1;
    while (lookahead < content.length && /\s/.test(content[lookahead])) {
      lookahead += 1;
    }

    const next = content[lookahead];
    if (next === '}' || next === ']') {
      continue;
    }

    result += current;
  }

  return result;
}
