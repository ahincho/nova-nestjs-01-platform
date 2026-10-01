/**
 * El mensaje de un 5xx que la tabla no nombra, y el de un 500, cuando nadie
 * configura otro.
 */
export const DEFAULT_INTERNAL_ERROR_MESSAGE = 'Error interno del servidor';

/**
 * El mensaje de un 4xx que la tabla no nombra.
 */
export const DEFAULT_REQUEST_ERROR_MESSAGE = 'La solicitud no se pudo atender';

// Los mensajes genéricos de la plataforma (ADR-031, pregunta abierta 2): van en
// español, y son los mismos en los tres stacks. Se indexan por status y no por
// código: un catálogo propio puede renombrar el código de un 404 y el mensaje
// del status sigue siendo el que dice qué pasó.
const STATUS_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  400: 'La solicitud no es válida',
  401: 'Hace falta autenticarse',
  403: 'No hay permiso para esta operación',
  404: 'El recurso no existe',
  405: 'El método no está permitido en este recurso',
  406: 'No hay una representación en el formato pedido',
  408: 'La solicitud tardó demasiado en llegar',
  409: 'La operación choca con el estado actual del recurso',
  410: 'El recurso ya no está disponible',
  415: 'El tipo de contenido no está soportado',
  422: 'La solicitud no se puede procesar',
  429: 'Demasiadas solicitudes; conviene esperar antes de reintentar',
  500: DEFAULT_INTERNAL_ERROR_MESSAGE,
  502: 'Una dependencia respondió con un error',
  503: 'El servicio no está disponible en este momento',
  504: 'Una dependencia no respondió a tiempo',
};

/**
 * El mensaje genérico de un status: el que lleva todo 5xx, y un 4xx que no trae
 * uno propio.
 *
 * Un 4xx que la tabla no nombra lleva {@link DEFAULT_REQUEST_ERROR_MESSAGE}, y
 * cualquier otro 5xx, {@link DEFAULT_INTERNAL_ERROR_MESSAGE}.
 */
export function statusToErrorMessage(status: number): string {
  return (
    STATUS_ERROR_MESSAGES[status] ??
    (status >= 500
      ? DEFAULT_INTERNAL_ERROR_MESSAGE
      : DEFAULT_REQUEST_ERROR_MESSAGE)
  );
}
