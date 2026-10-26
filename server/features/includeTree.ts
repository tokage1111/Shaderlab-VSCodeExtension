import { IncludeTreeChild, IncludeTreeRootsResult } from '../../shared/protocol';
import { Workspace } from '../analysis/workspace';
import { isShaderSourcePath, pathKey, uriToPath } from '../project/pathUtils';

/** アクティブなファイルを含むrootの一覧(Include Treeビューの最上位)。 */
export async function includeTreeRoots(workspace: Workspace, activeUri: string | undefined): Promise<IncludeTreeRootsResult> {
  const pinned = workspace.getPinnedRoot();
  const pinnedUri = pinned ? workspace.uriFor(pinned) : null;
  const activePath = activeUri ? uriToPath(activeUri) : undefined;
  if (!activeUri || !activePath || !isShaderSourcePath(activePath)) {
    return { roots: [], pinnedUri };
  }
  await workspace.graph.scanWorkspace();
  workspace.refreshGraphFor(activeUri);

  const roots = workspace.graph.findRoots(activePath);
  const file = workspace.getOpenFile(activeUri) ?? (await workspace.loadFile(activePath));
  const analysisRoot = file ? await workspace.analysisRootFor(file) : activePath;
  if (!roots.some((root) => pathKey(root) === pathKey(analysisRoot))) roots.unshift(analysisRoot);

  return {
    pinnedUri,
    roots: roots.map((root) => ({
      uri: workspace.uriFor(root),
      active: pathKey(root) === pathKey(analysisRoot),
      pinned: !!pinned && pathKey(root) === pathKey(pinned),
    })),
  };
}

export async function includeTreeChildren(workspace: Workspace, uri: string): Promise<IncludeTreeChild[]> {
  const filePath = uriToPath(uri);
  if (!filePath) return [];
  workspace.refreshGraphFor(uri);
  const edges = await workspace.graph.getEdges(filePath);
  return edges.map((edge) => ({
    uri: edge.resolution.status === 'resolved' ? workspace.uriFor(edge.resolution.path) : undefined,
    includePath: edge.includePath,
    status: edge.resolution.status,
    line: edge.line,
  }));
}
