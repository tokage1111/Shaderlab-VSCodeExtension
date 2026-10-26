import { ParameterInformation, SignatureHelp, SignatureInformation } from 'vscode-languageserver';
import { getObjectMethods, INTRINSICS } from '../analysis/builtins';
import { SourceFile } from '../analysis/sourceFile';
import { TypeEvaluator } from '../analysis/typeEvaluator';
import { Workspace } from '../analysis/workspace';
import { lowerBoundToken } from '../parser/lexer';
import { formatParameter } from './format';

/** 呼び出し中の関数の引数情報。 */
export async function provideSignatureHelp(workspace: Workspace, file: SourceFile, offset: number): Promise<SignatureHelp | null> {
  const unitIndex = file.unitIndexAt(offset);
  if (unitIndex < 0 || file.isInComment(offset)) return null;
  const unit = file.units[unitIndex];
  const tokens = file.tokens;

  // カーソル位置から遡って、閉じていない '(' を探す。
  let index = lowerBoundToken(tokens, offset) - 1;
  let depth = 0;
  let activeParameter = 0;
  for (; index >= unit.tokenStart; index--) {
    const value = tokens[index].value;
    if (value === ')' || value === ']') depth++;
    else if (value === '(' || value === '[') {
      if (depth === 0) {
        if (value === '(') break;
        // 添字の中
        return null;
      }
      depth--;
    } else if (value === ',' && depth === 0) activeParameter++;
    else if ((value === ';' || value === '{' || value === '}') && depth === 0) return null;
  }
  if (index < unit.tokenStart) return null;
  const callee = tokens[index - 1];
  if (!callee || callee.kind !== 'ident') return null;

  const context = await workspace.contextForUnit(file, unitIndex);
  const signatures: SignatureInformation[] = [];

  if (tokens[index - 2]?.value === '.') {
    const evaluator = new TypeEvaluator(context, file, unitIndex);
    const start = evaluator.chainStart(index - 3);
    const objectType = start >= 0 ? evaluator.evaluateChain(start, index - 3) : undefined;
    if (objectType) {
      const resolved = evaluator.resolve(objectType);
      const method = getObjectMethods(resolved.base)?.[callee.value];
      if (method) signatures.push(fromSignatureText(method.signature, method.doc));
      for (const struct of evaluator.findStructs(resolved.base)) {
        const fn = struct.node.methods.find((candidate) => candidate.name === callee.value);
        if (fn) signatures.push(fromParameters(`${fn.returnType} ${fn.name}`, fn.params.map(formatParameter)));
      }
    }
  } else {
    for (const symbol of context.lookup(callee.value)) {
      if (symbol.kind === 'function') {
        signatures.push(fromParameters(`${symbol.node.returnType} ${symbol.name}`, symbol.node.params.map(formatParameter)));
      } else if (symbol.kind === 'macro' && symbol.node.params) {
        signatures.push(fromParameters(`#define ${symbol.name}`, symbol.node.params));
      }
    }
    const intrinsic = INTRINSICS[callee.value];
    if (intrinsic && signatures.length === 0) signatures.push(fromSignatureText(intrinsic.signature, intrinsic.doc));
  }
  if (signatures.length === 0) return null;

  // 引数の数が足りるオーバーロードを優先して選ぶ。
  let activeSignature = signatures.findIndex((signature) => (signature.parameters?.length ?? 0) > activeParameter);
  if (activeSignature < 0) activeSignature = 0;
  return { signatures, activeSignature, activeParameter };
}

function fromParameters(prefix: string, params: string[]): SignatureInformation {
  let label = `${prefix}(`;
  const parameters: ParameterInformation[] = [];
  params.forEach((param, index) => {
    if (index > 0) label += ', ';
    parameters.push({ label: [label.length, label.length + param.length] });
    label += param;
  });
  label += ')';
  return { label, parameters };
}

/** `T lerp(T a, T b, T s)` 形式の文字列から引数位置を求める。 */
function fromSignatureText(signature: string, doc: string): SignatureInformation {
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  const parameters: ParameterInformation[] = [];
  let start = open + 1;
  let depth = 0;
  for (let i = open + 1; i <= close; i++) {
    const character = signature[i];
    if (character === '[') depth++;
    else if (character === ']') depth--;
    if ((character === ',' && depth <= 0) || i === close) {
      let paramStart = start;
      while (signature[paramStart] === ' ' || signature[paramStart] === '[') paramStart++;
      let paramEnd = i;
      while (paramEnd > paramStart && (signature[paramEnd - 1] === ' ' || signature[paramEnd - 1] === ']')) paramEnd--;
      if (paramEnd > paramStart) parameters.push({ label: [paramStart, paramEnd] });
      start = i + 1;
    }
  }
  return { label: signature, documentation: doc, parameters };
}
