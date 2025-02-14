import { diff } from 'fast-array-diff';
import { isEqual } from 'lodash';
import * as path from 'path';
import { URI } from '../common/uri';
import { Resource, NoteLink, Note, Point, Position } from '../model/note';
import {
  computeRelativeURI,
  isSome,
  isNone,
  parseUri,
  placeholderUri,
  isPlaceholder,
  isSameUri,
} from '../utils';
import { Emitter } from '../common/event';
import { IDisposable } from '../index';

export type Connection = {
  source: URI;
  target: URI;
  link: NoteLink;
};

export function getReferenceType(
  reference: URI | string
): 'uri' | 'absolute-path' | 'relative-path' | 'key' {
  if (URI.isUri(reference)) {
    return 'uri';
  }
  const isPath = reference.split('/').length > 1;
  if (!isPath) {
    return 'key';
  }
  const isAbsPath = isPath && reference.startsWith('/');
  return isAbsPath ? 'absolute-path' : 'relative-path';
}

const pathToResourceId = (pathValue: string) => {
  const { ext } = path.parse(pathValue);
  return ext.length > 0 ? pathValue : pathValue + '.md';
};
const uriToResourceId = (uri: URI) => pathToResourceId(uri.path);

const pathToResourceName = (pathValue: string) => path.parse(pathValue).name;
const uriToResourceName = (uri: URI) => pathToResourceName(uri.path);

const pathToPlaceholderId = (value: string) => value;
const uriToPlaceholderId = (uri: URI) => pathToPlaceholderId(uri.path);

export class FoamWorkspace implements IDisposable {
  private onDidAddEmitter = new Emitter<Resource>();
  private onDidUpdateEmitter = new Emitter<{ old: Resource; new: Resource }>();
  private onDidDeleteEmitter = new Emitter<Resource>();
  onDidAdd = this.onDidAddEmitter.event;
  onDidUpdate = this.onDidUpdateEmitter.event;
  onDidDelete = this.onDidDeleteEmitter.event;

  /**
   * Resources by key / slug
   */
  private resourcesByName: { [key: string]: string[] } = {};
  /**
   * Resources by URI
   */
  private resources: { [key: string]: Resource } = {};
  /**
   * Placehoders by key / slug / value
   */
  private placeholders: { [key: string]: Resource } = {};

  /**
   * Maps the connections starting from a URI
   */
  private links: { [key: string]: Connection[] } = {};
  /**
   * Maps the connections arriving to a URI
   */
  private backlinks: { [key: string]: Connection[] } = {};
  /**
   * List of disposables to destroy with the workspace
   */
  disposables: IDisposable[] = [];

  exists(uri: URI) {
    return FoamWorkspace.exists(this, uri);
  }
  list() {
    return FoamWorkspace.list(this);
  }
  get(uri: URI) {
    return FoamWorkspace.get(this, uri);
  }
  find(uri: URI | string) {
    return FoamWorkspace.find(this, uri);
  }
  set(resource: Resource) {
    return FoamWorkspace.set(this, resource);
  }
  delete(uri: URI) {
    return FoamWorkspace.delete(this, uri);
  }

  resolveLink(note: Note, link: NoteLink) {
    return FoamWorkspace.resolveLink(this, note, link);
  }
  resolveLinks(keepMonitoring: boolean = false) {
    return FoamWorkspace.resolveLinks(this, keepMonitoring);
  }
  getAllConnections() {
    return FoamWorkspace.getAllConnections(this);
  }
  getConnections(uri: URI) {
    return FoamWorkspace.getConnections(this, uri);
  }
  getLinks(uri: URI) {
    return FoamWorkspace.getLinks(this, uri);
  }
  getBacklinks(uri: URI) {
    return FoamWorkspace.getBacklinks(this, uri);
  }

  dispose(): void {
    this.onDidAddEmitter.dispose();
    this.onDidDeleteEmitter.dispose();
    this.onDidUpdateEmitter.dispose();
    this.disposables.forEach(d => d.dispose());
  }

  public static resolveLink(
    workspace: FoamWorkspace,
    note: Note,
    link: NoteLink
  ): URI {
    let targetUri: URI | undefined;
    switch (link.type) {
      case 'wikilink':
        const definitionUri = note.definitions.find(
          def => def.label === link.slug
        )?.url;
        if (isSome(definitionUri)) {
          const definedUri = parseUri(note.uri, definitionUri);
          targetUri =
            FoamWorkspace.find(workspace, definedUri, note.uri)?.uri ??
            placeholderUri(definedUri.path);
        } else {
          targetUri =
            FoamWorkspace.find(workspace, link.slug, note.uri)?.uri ??
            placeholderUri(link.slug);
        }
        break;

      case 'link':
        targetUri =
          FoamWorkspace.find(workspace, link.target, note.uri)?.uri ??
          placeholderUri(parseUri(note.uri, link.target).path);
        break;
    }

    if (isPlaceholder(targetUri)) {
      // we can only add placeholders when links are being resolved
      workspace = FoamWorkspace.set(workspace, {
        type: 'placeholder',
        uri: targetUri,
      });
    }
    return targetUri;
  }

  /**
   * Computes all the links in the workspace, connecting notes and
   * creating placeholders.
   *
   * @param workspace the target workspace
   * @param keepMonitoring whether to recompute the links when the workspace changes
   * @returns the resolved workspace
   */
  public static resolveLinks(
    workspace: FoamWorkspace,
    keepMonitoring: boolean = false
  ): FoamWorkspace {
    workspace.links = {};
    workspace.backlinks = {};
    workspace.placeholders = {};

    workspace = Object.values(workspace.list()).reduce(
      (w, resource) => FoamWorkspace.resolveResource(w, resource),
      workspace
    );
    if (keepMonitoring) {
      workspace.disposables.push(
        workspace.onDidAdd(resource => {
          FoamWorkspace.updateLinksRelatedToAddedResource(workspace, resource);
        }),
        workspace.onDidUpdate(change => {
          FoamWorkspace.updateLinksForResource(
            workspace,
            change.old,
            change.new
          );
        }),
        workspace.onDidDelete(resource => {
          FoamWorkspace.updateLinksRelatedToDeletedResource(
            workspace,
            resource
          );
        })
      );
    }
    return workspace;
  }

  public static getAllConnections(workspace: FoamWorkspace): Connection[] {
    return Object.values(workspace.links).flat();
  }

  public static getConnections(
    workspace: FoamWorkspace,
    uri: URI
  ): Connection[] {
    return [
      ...(workspace.links[uri.path] || []),
      ...(workspace.backlinks[uri.path] || []),
    ];
  }

  public static getLinks(workspace: FoamWorkspace, uri: URI): Connection[] {
    return workspace.links[uri.path] ?? [];
  }

  public static getBacklinks(workspace: FoamWorkspace, uri: URI): Connection[] {
    return workspace.backlinks[uri.path] ?? [];
  }

  public static set(
    workspace: FoamWorkspace,
    resource: Resource
  ): FoamWorkspace {
    if (resource.type === 'placeholder') {
      workspace.placeholders[uriToPlaceholderId(resource.uri)] = resource;
      return workspace;
    }
    const id = uriToResourceId(resource.uri);
    const old = FoamWorkspace.find(workspace, resource.uri);
    const name = uriToResourceName(resource.uri);
    workspace.resources[id] = resource;
    workspace.resourcesByName[name] = workspace.resourcesByName[name] ?? [];
    workspace.resourcesByName[name].push(id);
    isSome(old)
      ? workspace.onDidUpdateEmitter.fire({ old: old, new: resource })
      : workspace.onDidAddEmitter.fire(resource);
    return workspace;
  }

  public static exists(workspace: FoamWorkspace, uri: URI): boolean {
    return isSome(workspace.resources[uriToResourceId(uri)]);
  }

  public static list(workspace: FoamWorkspace): Resource[] {
    return [
      ...Object.values(workspace.resources),
      ...Object.values(workspace.placeholders),
    ];
  }

  public static get(workspace: FoamWorkspace, uri: URI): Resource {
    const note = FoamWorkspace.find(workspace, uri);
    if (isSome(note)) {
      return note;
    } else {
      throw new Error('Resource not found: ' + uri.path);
    }
  }

  public static find(
    workspace: FoamWorkspace,
    resourceId: URI | string,
    reference?: URI
  ): Resource | null {
    const refType = getReferenceType(resourceId);
    switch (refType) {
      case 'uri':
        const uri = resourceId as URI;
        if (uri.scheme === 'placeholder') {
          return uri.path in workspace.placeholders
            ? { type: 'placeholder', uri: uri }
            : null;
        } else {
          return FoamWorkspace.exists(workspace, uri)
            ? workspace.resources[uriToResourceId(uri)]
            : null;
        }

      case 'key':
        const name = pathToResourceName(resourceId as string);
        const paths = workspace.resourcesByName[name];
        if (isNone(paths) || paths.length === 0) {
          const placeholderId = pathToPlaceholderId(resourceId as string);
          return workspace.placeholders[placeholderId] ?? null;
        }
        // prettier-ignore
        const sortedPaths = paths.length === 1
          ? paths
          : paths.sort((a, b) => a.localeCompare(b));
        return workspace.resources[sortedPaths[0]];

      case 'absolute-path':
        const resourceUri = URI.file(resourceId as string);
        return (
          workspace.resources[uriToResourceId(resourceUri)] ??
          workspace.placeholders[uriToPlaceholderId(resourceUri)]
        );

      case 'relative-path':
        if (isNone(reference)) {
          return null;
        }
        const relativePath = resourceId as string;
        const targetUri = computeRelativeURI(reference, relativePath);
        return (
          workspace.resources[uriToResourceId(targetUri)] ??
          workspace.placeholders[pathToPlaceholderId(resourceId as string)]
        );

      default:
        throw new Error('Unexpected reference type: ' + refType);
    }
  }

  public static delete(workspace: FoamWorkspace, uri: URI): Resource | null {
    const id = uriToResourceId(uri);
    const deleted = workspace.resources[id];
    delete workspace.resources[id];

    const name = uriToResourceName(uri);
    workspace.resourcesByName[name] = workspace.resourcesByName[name].filter(
      resId => resId !== id
    );
    if (workspace.resourcesByName[name].length === 0) {
      delete workspace.resourcesByName[name];
    }

    isSome(deleted) && workspace.onDidDeleteEmitter.fire(deleted);
    return deleted ?? null;
  }

  public static resolveResource(workspace: FoamWorkspace, resource: Resource) {
    if (resource.type === 'note') {
      delete workspace.links[resource.uri.path];
      // prettier-ignore
      resource.links.forEach(link => {
        const targetUri = FoamWorkspace.resolveLink(workspace, resource, link);
        workspace = FoamWorkspace.connect(workspace, resource.uri, targetUri, link);
      });
    }
    return workspace;
  }

  private static updateLinksForResource(
    workspace: FoamWorkspace,
    oldResource: Resource,
    newResource: Resource
  ) {
    if (oldResource.uri.path !== newResource.uri.path) {
      throw new Error(
        'Unexpected State: update should only be called on same resource ' +
          {
            old: oldResource,
            new: newResource,
          }
      );
    }
    if (oldResource.type === 'note' && newResource.type === 'note') {
      const patch = diff(oldResource.links, newResource.links, isEqual);
      workspace = patch.removed.reduce((ws, link) => {
        const target = ws.resolveLink(oldResource, link);
        return FoamWorkspace.disconnect(ws, oldResource.uri, target, link);
      }, workspace);
      workspace = patch.added.reduce((ws, link) => {
        const target = ws.resolveLink(newResource, link);
        return FoamWorkspace.connect(ws, newResource.uri, target, link);
      }, workspace);
    }
    return workspace;
  }

  private static updateLinksRelatedToAddedResource(
    workspace: FoamWorkspace,
    resource: Resource
  ) {
    // check if any existing connection can be filled by new resource
    const name = uriToResourceName(resource.uri);
    if (name in workspace.placeholders) {
      const placeholder = workspace.placeholders[name];
      delete workspace.placeholders[name];
      const resourcesToUpdate = workspace.backlinks[placeholder.uri.path] ?? [];
      workspace = resourcesToUpdate.reduce(
        (ws, res) => FoamWorkspace.resolveResource(ws, ws.get(res.source)),
        workspace
      );
    }

    // resolve the resource
    workspace = FoamWorkspace.resolveResource(workspace, resource);
  }

  private static updateLinksRelatedToDeletedResource(
    workspace: FoamWorkspace,
    resource: Resource
  ) {
    const uri = resource.uri;

    // remove forward links from old resource
    const resourcesPointedByDeletedNote = workspace.links[uri.path] ?? [];
    delete workspace.links[uri.path];
    workspace = resourcesPointedByDeletedNote.reduce(
      (ws, connection) =>
        FoamWorkspace.disconnect(ws, uri, connection.target, connection.link),
      workspace
    );

    // recompute previous links to old resource
    const notesPointingToDeletedResource = workspace.backlinks[uri.path] ?? [];
    delete workspace.backlinks[uri.path];
    workspace = notesPointingToDeletedResource.reduce(
      (ws, link) => FoamWorkspace.resolveResource(ws, ws.get(link.source)),
      workspace
    );
    return workspace;
  }

  private static connect(
    workspace: FoamWorkspace,
    source: URI,
    target: URI,
    link: NoteLink
  ) {
    const connection = { source, target, link };

    workspace.links[source.path] = workspace.links[source.path] ?? [];
    workspace.links[source.path].push(connection);
    workspace.backlinks[target.path] = workspace.backlinks[target.path] ?? [];
    workspace.backlinks[target.path].push(connection);

    return workspace;
  }

  /**
   * Removes a connection, or all connections, between the source and
   * target resources
   *
   * @param workspace the Foam workspace
   * @param source the source resource
   * @param target the target resource
   * @param link the link reference, or `true` to remove all links
   * @returns the updated Foam workspace
   */
  private static disconnect(
    workspace: FoamWorkspace,
    source: URI,
    target: URI,
    link: NoteLink | true
  ) {
    const connectionsToKeep =
      link === true
        ? (c: Connection) =>
            !isSameUri(source, c.source) || !isSameUri(target, c.target)
        : (c: Connection) => !isSameConnection({ source, target, link }, c);

    workspace.links[source.path] = workspace.links[source.path]?.filter(
      connectionsToKeep
    );
    if (workspace.links[source.path].length === 0) {
      delete workspace.links[source.path];
    }
    workspace.backlinks[target.path] = workspace.backlinks[target.path]?.filter(
      connectionsToKeep
    );
    if (workspace.backlinks[target.path].length === 0) {
      delete workspace.backlinks[target.path];
      if (isPlaceholder(target)) {
        delete workspace.placeholders[uriToPlaceholderId(target)];
      }
    }
    return workspace;
  }
}

// TODO move these utility fns to appropriate places

const isSameConnection = (a: Connection, b: Connection) =>
  isSameUri(a.source, b.source) &&
  isSameUri(a.target, b.target) &&
  isSameLink(a.link, b.link);

const isSameLink = (a: NoteLink, b: NoteLink) =>
  a.type === b.type && isSamePosition(a.position, b.position);

const isSamePosition = (a: Position, b: Position) =>
  isSamePoint(a.start, b.start) && isSamePoint(a.end, b.end);

const isSamePoint = (a: Point, b: Point) =>
  a.column === b.column && a.line === b.line;
