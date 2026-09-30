/**
 * La capa donde nació un error (ADR-031).
 *
 * Es la regla que ordena el módulo: `domain` y `application` son **esperados**,
 * y `infrastructure` y `platform` son **incidentes**. Un 404 de negocio no tiene
 * que despertar a nadie, y un proveedor que dejó de contestar sí; clasificar por
 * capa es lo que permite alertar sobre lo segundo sin que lo primero ensucie la
 * señal.
 *
 * El valor es el nombre en minúsculas porque es lo que se escribe en el campo
 * `layer` del log.
 */
export enum Layer {
  /**
   * Una regla de negocio: el recurso no existe, o su estado no admite la
   * operación.
   */
  DOMAIN = 'domain',
  /** La operación que se pidió: la entrada, la identidad, un límite. */
  APPLICATION = 'application',
  /** Una dependencia: no está, no contestó a tiempo o contestó mal. */
  INFRASTRUCTURE = 'infrastructure',
  /** Un defecto o una falla del propio servicio durante una petición. */
  PLATFORM = 'platform',
}
