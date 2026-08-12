import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import scrapeRouter from "./scrape.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(scrapeRouter);

export default router;
