import ts from 'typescript';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export type PropClassification = 'prop' | 'event' | 'slot' | 'passthrough';

export interface ClassifiedProp {
  classification: PropClassification;
  deprecated: boolean;
}

export interface RefMethod {
  name: string;
  signature: string;
  jsDoc: string;
}

export class PackageAnalyzer {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly pkgRoot: string;

  constructor(packageName: string) {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve(`${packageName}/package.json`);
    this.pkgRoot = path.dirname(pkgJsonPath);

    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    const mainEntry = pkgJson.main ?? pkgJson.module ?? './index.js';
    const dtsPath = path.join(this.pkgRoot, mainEntry.replace(/\.js$/, '.d.ts'));

    this.program = ts.createProgram([dtsPath], {
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      baseUrl: this.pkgRoot,
      lib: ['lib.dom.d.ts', 'lib.es2022.d.ts'],
    });
    this.checker = this.program.getTypeChecker();
  }

  getPropsType(propsTypeName: string, propsFile: string): ts.Type | undefined {
    const sf = this.program.getSourceFile(propsFile);
    if (!sf) return undefined;
    const modSym = this.checker.getSymbolAtLocation(sf);
    if (!modSym) return undefined;
    const propsSym = this.checker.getExportsOfModule(modSym).find(e => e.name === propsTypeName);
    if (!propsSym) return undefined;
    return this.checker.getDeclaredTypeOfSymbol(propsSym);
  }

  classifyProp(memberSym: ts.Symbol): ClassifiedProp {
    const deprecated = memberSym.getJsDocTags().some(t => t.name === 'deprecated');
    const type = this.checker.getTypeOfSymbol(memberSym);
    const stripped = this.stripNullUndefined(type);
    if (this.isEventHandler(stripped)) return { classification: 'event', deprecated };
    if (this.isReactType(stripped)) return { classification: 'slot', deprecated };
    if (this.isPassthrough(stripped)) return { classification: 'passthrough', deprecated };
    return { classification: 'prop', deprecated };
  }

  classifyAllProps(propsType: ts.Type): Map<string, ClassifiedProp> {
    const result = new Map<string, ClassifiedProp>();
    for (const member of propsType.getProperties()) {
      result.set(member.name, this.classifyProp(member));
    }
    return result;
  }

  getEventDetailType(memberSym: ts.Symbol): ts.Type | undefined {
    const type = this.stripNullUndefined(this.checker.getTypeOfSymbol(memberSym));
    const sigs = type.getCallSignatures();
    if (!sigs.length) return undefined;
    const firstParam = sigs[0].getParameters()[0];
    if (!firstParam) return undefined;
    const paramType = this.checker.getTypeOfSymbol(firstParam);
    const detailProp = paramType.getProperty?.('detail');
    return detailProp ? this.checker.getTypeOfSymbol(detailProp) : undefined;
  }

  getBaseTypes(propsTypeName: string, propsFile: string): string[] {
    const sf = this.program.getSourceFile(propsFile);
    if (!sf) return [];
    const modSym = this.checker.getSymbolAtLocation(sf);
    if (!modSym) return [];
    const propsSym = this.checker.getExportsOfModule(modSym).find(e => e.name === propsTypeName);
    if (!propsSym) return [];
    const bases: string[] = [];
    for (const decl of propsSym.getDeclarations() ?? []) {
      if (!ts.isInterfaceDeclaration(decl) || !decl.heritageClauses) continue;
      for (const clause of decl.heritageClauses) {
        for (const base of clause.types) {
          bases.push(base.expression.getText());
        }
      }
    }
    return bases;
  }

  private isEventHandler(type: ts.Type): boolean {
    const sigs = type.getCallSignatures();
    if (!sigs.length) return false;
    if (sigs[0].getParameters().length !== 1) return false;
    const paramType = this.checker.getTypeOfSymbol(sigs[0].getParameters()[0]);
    return this.isDomEventType(paramType);
  }

  private isDomEventType(type: ts.Type, seen = new Set<ts.Type>()): boolean {
    if (seen.has(type)) return false;
    seen.add(type);

    const sym = type.getSymbol?.();
    if (sym && this.isDeclaredInDomLib(sym)) return true;

    const alias = type.aliasSymbol;
    if (!alias) return false;
    const decl = alias.getDeclarations()?.[0];
    if (!decl || !ts.isTypeAliasDeclaration(decl)) return false;
    const typeNode = decl.type;
    if (!ts.isTypeReferenceNode(typeNode) || !typeNode.typeArguments?.length) return false;

    for (const arg of typeNode.typeArguments) {
      const argType = this.checker.getTypeAtLocation(arg);
      if (this.isDomEventType(argType, seen)) return true;
    }
    return false;
  }

  private isDeclaredInDomLib(sym: ts.Symbol): boolean {
    return sym.getDeclarations()?.some(d =>
      d.getSourceFile().fileName.includes('lib.dom'),
    ) ?? false;
  }

  getRefMethods(propsTypeName: string, propsFile: string): RefMethod[] {
    const sf = this.program.getSourceFile(propsFile);
    if (!sf) return [];
    const modSym = this.checker.getSymbolAtLocation(sf);
    if (!modSym) return [];
    const propsSym = this.checker.getExportsOfModule(modSym).find(e => e.name === propsTypeName);
    if (!propsSym?.exports) return [];
    const refSym = propsSym.exports.get('Ref' as ts.__String);
    if (!refSym) return [];
    const refType = this.checker.getDeclaredTypeOfSymbol(refSym);
    const methods: RefMethod[] = [];
    for (const member of refType.getProperties()) {
      const memberType = this.checker.getTypeOfSymbol(member);
      const sigs = memberType.getCallSignatures();
      if (!sigs.length) continue;
      methods.push({
        name: member.name,
        signature: this.checker.typeToString(memberType),
        jsDoc: ts.displayPartsToString(member.getDocumentationComment(this.checker)),
      });
    }
    return methods;
  }

  private isPassthrough(type: ts.Type): boolean {
    const members = type.getProperties();
    if (members.length < 20) return false;
    for (const member of members) {
      const memberType = this.checker.getTypeOfSymbol(member);
      const stripped = this.stripNullUndefined(memberType);
      const sigs = stripped.getCallSignatures();
      if (!sigs.length) continue;
      const params = sigs[0].getParameters();
      if (!params.length) continue;
      const paramType = this.checker.getTypeOfSymbol(params[0]);
      const paramSym = paramType.aliasSymbol ?? paramType.getSymbol?.();
      if (paramSym?.getDeclarations()?.some(d => d.getSourceFile().fileName.includes('@types/react'))) {
        return true;
      }
    }
    return false;
  }

  private isReactType(type: ts.Type): boolean {
    const alias = type.aliasSymbol;
    if (!alias) return false;
    return alias.getDeclarations()?.some(d =>
      d.getSourceFile().fileName.includes('@types/react'),
    ) ?? false;
  }

  private stripNullUndefined(type: ts.Type): ts.Type {
    if (!type.isUnion()) return type;
    const filtered = type.types.filter(t =>
      !(t.flags & ts.TypeFlags.Undefined) && !(t.flags & ts.TypeFlags.Null),
    );
    if (filtered.length === 0 || filtered.length === type.types.length) return type;
    if (filtered.length === 1) return filtered[0];
    return type;
  }
}
