import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import scrapeRouter from "./scrape.js";
import openapiRouter from "./openapi.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(scrapeRouter);
router.use(openapiRouter);

export default router;
