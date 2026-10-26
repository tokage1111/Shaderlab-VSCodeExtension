import { DocumentSymbol, SymbolKind } from 'vscode-languageserver';
import { SourceFile } from '../analysis/sourceFile';
import { HlslUnit } from '../parser/ast';
import { formatFunction, formatVariable } from './format';

/** アウトライン表示用のシンボル階層。 */
export function provideDocumentSymbols(file: SourceFile): DocumentSymbol[] {
  const range = (start: number, end: number) => file.lineIndex.range(start, Math.max(start, end));
  const symbol = (
    name: string,
    kind: SymbolKind,
    start: number,
    end: number,
    selectionStart: number,
    selectionEnd: number,
    detail?: string,
    children?: DocumentSymbol[],
  ): DocumentSymbol => ({
    name: name || '(無名)',
    kind,
    detail,
    range: range(start, end),
    selectionRange: range(selectionStart, selectionEnd),
    children,
  });

  const unitSymbols = (unit: HlslUnit): DocumentSymbol[] => {
    const result: DocumentSymbol[] = [];
    for (const struct of unit.structs) {
      result.push(
        symbol(struct.name, SymbolKind.Struct, struct.start, struct.end, struct.nameStart, struct.nameEnd, undefined, [
          ...struct.fields.map((field) =>
            symbol(field.name, SymbolKind.Field, field.start, field.end, field.nameStart, field.nameEnd, formatVariable(field)),
          ),
          ...struct.methods.map((method) =>
            symbol(method.name, SymbolKind.Method, method.start, method.end, method.nameStart, method.nameEnd, formatFunction(method)),
          ),
        ]),
      );
    }
    for (const cbuffer of unit.cbuffers) {
      result.push(
        symbol(
          cbuffer.name,
          SymbolKind.Namespace,
          cbuffer.start,
          cbuffer.end,
          cbuffer.nameStart,
          cbuffer.nameEnd,
          'cbuffer',
          cbuffer.fields.map((field) =>
            symbol(field.name, SymbolKind.Variable, field.start, field.end, field.nameStart, field.nameEnd, formatVariable(field)),
          ),
        ),
      );
    }
    for (const variable of unit.globals) {
      result.push(
        symbol(variable.name, SymbolKind.Variable, variable.start, variable.end, variable.nameStart, variable.nameEnd, formatVariable(variable)),
      );
    }
    for (const typedef of unit.typedefs) {
      result.push(symbol(typedef.name, SymbolKind.TypeParameter, typedef.start, typedef.end, typedef.nameStart, typedef.nameEnd, typedef.type));
    }
    for (const fn of unit.functions) {
      result.push(symbol(fn.name, SymbolKind.Function, fn.start, fn.end, fn.nameStart, fn.nameEnd, formatFunction(fn)));
    }
    for (const macro of unit.macros) {
      result.push(symbol(macro.name, SymbolKind.Constant, macro.start, macro.end, macro.nameStart, macro.nameEnd, '#define'));
    }
    return result.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  };

  const shader = file.shader;
  if (!shader) return file.units[0] ? unitSymbols(file.units[0]) : [];

  const blockSymbol = (index: number): DocumentSymbol => {
    const block = shader.blocks[index];
    return symbol(block.kind, SymbolKind.Module, block.start, block.end, block.start, block.start + block.kind.length, undefined, unitSymbols(block.unit));
  };
  const children: DocumentSymbol[] = [];
  if (shader.propertiesSpan) {
    children.push(
      symbol(
        'Properties',
        SymbolKind.Namespace,
        shader.propertiesSpan.start,
        shader.propertiesSpan.end,
        shader.propertiesSpan.start,
        shader.propertiesSpan.start,
        undefined,
        shader.properties.map((property) =>
          symbol(property.name, SymbolKind.Property, property.start, property.end, property.nameStart, property.nameEnd, `${property.displayName} (${property.type})`),
        ),
      ),
    );
  }
  shader.blocks.forEach((block, index) => {
    if (block.subShaderIndex === undefined) children.push(blockSymbol(index));
  });
  shader.subShaders.forEach((subShader, subShaderIndex) => {
    const subChildren: DocumentSymbol[] = [];
    shader.blocks.forEach((block, index) => {
      if (block.subShaderIndex === subShaderIndex && block.passIndex === undefined) subChildren.push(blockSymbol(index));
    });
    subShader.passes.forEach((pass, passIndex) => {
      const passChildren: DocumentSymbol[] = [];
      shader.blocks.forEach((block, index) => {
        if (block.subShaderIndex === subShaderIndex && block.passIndex === passIndex) passChildren.push(blockSymbol(index));
      });
      const lightMode = pass.tags.find((tag) => tag.key === 'LightMode')?.value;
      subChildren.push(
        symbol(pass.name ? `Pass "${pass.name}"` : 'Pass', SymbolKind.Class, pass.start, pass.end, pass.start, pass.start + 4, lightMode, passChildren),
      );
    });
    const pipeline = subShader.tags.find((tag) => tag.key === 'RenderPipeline')?.value;
    children.push(symbol('SubShader', SymbolKind.Class, subShader.start, subShader.end, subShader.start, subShader.start + 9, pipeline, subChildren));
  });
  const shaderSection = shader.sections.find((section) => section.kind === 'Shader');
  if (!shaderSection) return children;
  return [
    symbol(
      shader.name ?? 'Shader',
      SymbolKind.File,
      Math.min(shaderSection.start, shader.nameStart ?? shaderSection.start),
      shaderSection.end,
      shader.nameStart ?? shaderSection.start,
      shader.nameEnd ?? shaderSection.start,
      undefined,
      children,
    ),
  ];
}
