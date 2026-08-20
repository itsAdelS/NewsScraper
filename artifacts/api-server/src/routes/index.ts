import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import scrapeRouter from "./scrape.js";
import openapiRouter from "./openapi.js";
import adminApiRouter from "./admin.js";
import discoveryRouter from "./discovery.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(scrapeRouter);
router.use(discoveryRouter);
router.use(openapiRouter);
router.use(adminApiRouter);

export default router;
