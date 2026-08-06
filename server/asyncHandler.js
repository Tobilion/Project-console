// Express 4 does not forward rejected promises from async handlers to the error handler —
// a rejection there surfaces as an unhandledRejection, which Node treats as fatal and takes
// the whole console down (route registration is otherwise fine, so nothing catches it).
// Wrap async route handlers so rejections reach Express's error middleware instead (a 500 +
// log line) rather than crashing the server.
export function asyncHandler(fn) {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
