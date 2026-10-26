import { Hover, MarkupKind } from 'vscode-languageserver';
import { DIRECTIVES, getSemanticInfo, PRAGMAS } from '../analysis/builtins';
import { resolveAt } from '../analysis/resolver';
import { SourceFile } from '../analysis/sourceFile';
import { Workspace } from '../analysis/workspace';
import { HlslParameter } from '../parser/ast';
import { codeBlock, displayPath, formatParameter, formatProperty, formatSymbol, formatVariable, symbolKindLabel } from './format';
import { findPropertyDeclarations } from './definition';

const MAX_OVERLOADS = 5;

export async function provideHover(workspace: Workspace, file: SourceFile, offset: number): Promise<Hover | null> {
  const result = await resolveAt(workspace, file, offset);
  if (!result) return null;
  const range = file.lineIndex.range(result.start, result.end);
  const markdown = (value: string): Hover => ({ contents: { kind: MarkupKind.Markdown, value }, range });
  const resolution = result.resolution;

  switch (resolution.kind) {
    case 'local': {
      const label = resolution.isParameter ? '引数' : 'ローカル変数';
      const code = resolution.isParameter ? formatParameter(resolution.variable as HlslParameter) : formatVariable(resolution.variable);
      return markdown(`${codeBlock(code)}\n${label} — 関数 \`${resolution.fn.name}\``);
    }
    case 'symbol': {
      const [first] = resolution.symbols;
      if (!first) return null;
      const sections: string[] = [];
      if (first.kind === 'function') {
        const overloads = resolution.symbols.filter((symbol) => symbol.kind === 'function');
        const shown = overloads.slice(0, MAX_OVERLOADS);
        sections.push(codeBlock(shown.map((symbol) => `${formatSymbol(symbol)};`).join('\n')));
        if (overloads.length > MAX_OVERLOADS) sections.push(`他 ${overloads.length - MAX_OVERLOADS} 個のオーバーロード`);
      } else {
        sections.push(codeBlock(formatSymbol(first)));
      }
      const location = first.file === file ? 'このファイル' : `\`${displayPath(first.file.path)}\``;
      sections.push(`${symbolKindLabel(first)} — ${location}:${first.file.lineIndex.positionAt(first.node.nameStart).line + 1}`);
      return markdown(sections.join('\n'));
    }
    case 'field': {
      const location = displayPath(resolution.struct.file.path);
      return markdown(`${codeBlock(formatVariable(resolution.field))}\n構造体 \`${resolution.struct.name}\` のメンバー — \`${location}\``);
    }
    case 'swizzle':
      return markdown(`${codeBlock(`${resolution.type} .${resolution.text}`)}\nスウィズル`);
    case 'method':
      return markdown(`${codeBlock(`${resolution.objectType.text}.${resolution.method.signature}`)}\n${resolution.method.doc}`);
    case 'intrinsic':
      return markdown(`${codeBlock(resolution.info.signature)}\nHLSL組み込み関数 — ${resolution.info.doc}`);
    case 'builtinType':
      return markdown(`${codeBlock(resolution.name)}\nHLSL組み込み型`);
    case 'semantic': {
      const info = getSemanticInfo(resolution.name);
      return markdown(`**${resolution.name}** (セマンティクス)\n\n${info ?? 'ユーザー定義のセマンティクス。'}`);
    }
    case 'include': {
      const include = resolution.include;
      if (resolution.resolution.status === 'resolved') {
        return markdown(`**#include** \`${include.path}\`\n\n→ \`${resolution.resolution.path}\``);
      }
      if (resolution.resolution.status === 'builtin') {
        return markdown(`**#include** \`${include.path}\`\n\nUnityエディタに同梱されるinclude(解析対象外)`);
      }
      return markdown(`**#include** \`${include.path}\`\n\nファイルが見つかりません。`);
    }
    case 'property': {
      const property = resolution.property;
      const declarations = await findPropertyDeclarations(workspace, file, property.name);
      const declared = declarations[0];
      const hlsl = declared ? `\n\nHLSL: ${codeBlock(formatVariable(declared.node))}` : '\n\nHLSL側で宣言されていません。';
      return markdown(`${codeBlock(formatProperty(property))}\nShaderLab Property — 表示名「${property.displayName}」${hlsl}`);
    }
    case 'keyword': {
      const doc = PRAGMAS[resolution.name] ?? DIRECTIVES[resolution.name];
      if (doc) return markdown(`**${resolution.name}**\n\n${doc}`);
      return null;
    }
    case 'unresolvedMember':
      return resolution.message ? markdown(resolution.message) : null;
    default:
      return null;
  }
}
