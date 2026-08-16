import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import adminUiRouter from "./admin/router.js";
import { logger } from "./lib/logger.js";

const app: Express = express();

// Behind the Replit proxy — needed for correct req.ip (login rate limiting)
// and req.secure (Secure cookie flag).
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Signed cookies for the admin session (separate from API bearer auth).
app.use(cookieParser(process.env.SESSION_SECRET));

app.use("/api", router);
// Admin console UI: /admin in production (root), and /api/admin-console so it
// is also reachable through the dev preview (whose base path is /api).
app.use("/admin", adminUiRouter);
app.use("/api/admin-console", adminUiRouter);

/**
 * JSON body-parser error handler.
 *
 * Express's built-in `express.json()` middleware throws a SyntaxError with
 * `type === "entity.parse.failed"` when the request body is malformed JSON.
 * Without this handler the default Express error handler would return an
 * HTML page — violating the "always return JSON" contract.
 *
 * This middleware MUST be placed after the routes so it only fires for
 * errors, not for every request.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // Body-parser errors (malformed JSON, payload too large, etc.)
  if (
    err &&
    typeof err === "object" &&
    "type" in err &&
    (err as { type: string }).type === "entity.parse.failed"
  ) {
    res
      .status(400)
      .json({ success: false, error: "Invalid JSON in request body" });
    return;
  }

  if (
    err &&
    typeof err === "object" &&
    "type" in err &&
    (err as { type: string }).type === "entity.too.large"
  ) {
    res
      .status(413)
      .json({ success: false, error: "Request body too large" });
    return;
  }

  // Generic fallback — always JSON, never HTML.
  const status =
    err && typeof err === "object" && "status" in err
      ? (err as { status: number }).status
      : 500;

  logger.error({ err }, "Unhandled request error");
  res.status(status).json({ success: false, error: "Internal server error" });
});

export default app;
