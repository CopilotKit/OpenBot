import type {
  CatalogueConnection,
  ModelCatalogue,
  ModelOption,
} from "./queries";

/**
 * Several AI connections in the model catalogue (`connections`), as the picker and a pick read them.
 *
 * With one connection, or against an OpenBot older than several, there is nothing to group: the
 * picker offers the catalogue's own models as it always did, and a pick names no connection.
 */

/**
 * The groups a picker draws: none when the catalogue has fewer than two connections (draw it as
 * before), otherwise every connection, the default first.
 */
export function pickerGroups(
  catalogue: ModelCatalogue | undefined,
): CatalogueConnection[] {
  const connections = catalogue?.connections ?? [];
  if (connections.length < 2) return [];
  return [
    ...connections.filter((one) => one.isDefault),
    ...connections.filter((one) => !one.isDefault),
  ];
}

/**
 * The connection a pick names, or the default one for null or absent. Undefined when it is not in
 * the catalogue: it was removed, or there is no default.
 */
export function connectionOf(
  catalogue: ModelCatalogue | undefined,
  id: string | null | undefined,
): CatalogueConnection | undefined {
  const connections = catalogue?.connections ?? [];
  return id
    ? connections.find((one) => one.id === id)
    : connections.find((one) => one.isDefault);
}

/**
 * One connection's models as a catalogue of their own, so what reads a catalogue (the default, an
 * option by id) reads that connection's.
 */
export function catalogueFor(
  catalogue: ModelCatalogue,
  connection: CatalogueConnection,
): ModelCatalogue {
  return {
    ...catalogue,
    default: connection.default,
    models: connection.models,
    choosable: catalogue.choosable,
  };
}

/** Every model the person can pick, across every connection. */
export function everyModel(
  catalogue: ModelCatalogue | undefined,
): ModelOption[] {
  const groups = pickerGroups(catalogue);
  return groups.length > 0
    ? groups.flatMap((one) => one.models)
    : (catalogue?.models ?? []);
}
