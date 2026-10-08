import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import config from "../site.config.json";

const items = defineCollection({
  loader: glob({ pattern: "*.json", base: `./src/content/${config.collection}` }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    image: z.string(),
    thumb: z.string(),
    width: z.number(),
    height: z.number(),
    color: z.string().optional(),
    location: z.string().optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
  }),
});

export const collections = { items };
