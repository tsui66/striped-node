import path from "path";
import fs from "fs";
import Stripe from "stripe";
import dotenv from "dotenv";
import { type PreStripedConfig, type SrtipedPrice } from "./types";
import { taxCodes } from './zod/tax-codes';

// Load environment variables from .env file

export async function deploy(
  configPath: string = "striped.config.ts",
  envFilePath: string = ".env"
): Promise<void> {
  console.log("Starting deployment process...");

  // Check if the .env file exists before loading
  if (fs.existsSync(envFilePath)) {
    dotenv.config({ path: envFilePath });
    console.log("Environment variables loaded from:", envFilePath);
  } else {
    console.warn(`Environment file not found: ${envFilePath}`);
    console.warn("Proceeding without loading environment variables.");
  }

  // Resolve the config path relative to the current working directory
  const resolvedConfigPath = path.resolve(process.cwd(), configPath);

  if (!fs.existsSync(resolvedConfigPath)) {
    throw new Error(`Configuration file not found: ${resolvedConfigPath}`);
  }

  // Import the configuration using the resolved path
  const { config }: { config: PreStripedConfig } = await import(resolvedConfigPath);
  console.log("Config:", config);
  // Initialize Stripe with your secret key
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

  if (!stripeSecretKey) {
    throw new Error(
      "Stripe secret key not found. Set STRIPE_SECRET_KEY in your environment variables or .env file."
    );
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: "2024-11-20.acacia" });

  console.log("Deploying configuration to Stripe...");

  // Initialize the mapping object
  const priceIdMapping: Record<string, any> = {};

  // Sync products and prices, collecting IDs into priceIdMapping
  await syncProductsAndPrices(stripe, config, priceIdMapping);

  // Deploy webhooks
  if (config.webhooks) {
    await deployWebhooks(stripe, config);
  }

  console.log("Configuration deployed successfully.");
}

// Add this new function at the end of the file
async function syncProductsAndPrices(
  stripe: Stripe,
  config: PreStripedConfig,
  priceIdMapping: Record<string, any>
): Promise<void> {
  console.log("Synchronizing products and prices...");

  const { products, features } = config;
  console.log("Products to synchronize:", products);

  for (const productKey in products) {
    const productConfig = products[productKey];
    console.log(`Processing product: ${productKey}`, productConfig);

    // Check if product already exists
    const existingProducts = await stripe.products.list({ limit: 100 });
    console.log(`Fetched existing products: ${existingProducts.data.length}`);

    let product = existingProducts.data.find(
      (p) => p.metadata.striped_product_key === productKey
    );

    const productData: Stripe.ProductCreateParams = {
      name: productConfig.name,
      metadata: {
        striped_product_key: productKey,
      },
      marketing_features: features ? productConfig.features.map((feature) => ({
        name: features[feature],
      })) : [],
      tax_code: productConfig.taxCode || taxCodes.DEFAULT, // Use default if not provided
    };

    console.log("Product data:", features, productConfig.features, productData);

    if (!product) {
      // Create new product
      if (productConfig?.id) {
        productData.id = productConfig.id;
      }
      product = await stripe.products.create(productData);
      console.log(`Created product: ${product.name} with tax code: ${product.tax_code}`);
    } else {
      // Update existing product if necessary
      product = await stripe.products.update(product.id, productData);
      console.log(`Updated product: ${product.name} with tax code: ${product.tax_code}`);
    }

    // Initialize the product entry in the mapping
    priceIdMapping[productKey] = {
      productId: product.id,
      prices: {},
    };

    // Sync prices
    await syncPrices(
      stripe,
      product,
      productConfig.prices,
      priceIdMapping,
      productKey
    );
  }
  console.log("All products synchronized.");
}

async function syncPrices(
  stripe: Stripe,
  product: Stripe.Product,
  pricesConfig: { [key: string]: SrtipedPrice },
  priceIdMapping: Record<string, any>,
  productKey: string
): Promise<void> {
  console.log(`Synchronizing prices for product: ${product.name}`);

  for (const priceKey in pricesConfig) {
    const priceConfig = pricesConfig[priceKey];

    // Set default tax code if not provided

    // Check if price already exists
    const existingPrices = await stripe.prices.list({
      product: product.id,
      limit: 100,
    });
    console.log(`Fetched existing prices: ${existingPrices.data.length}`);

    let price = existingPrices.data.find((p) => {
      const matchesKey = p.metadata.striped_price_key === priceKey;
      const matchesAmount = p.unit_amount === priceConfig.amount;
      const matchesInterval = priceConfig.type === "recurring"
        ? p.recurring?.interval === priceConfig.interval
        : !p.recurring;
      const matchesType = p.recurring ? "recurring" : "one_time";
      return matchesKey && matchesAmount && matchesInterval && matchesType === priceConfig.type;
    });

    if (!price) {
      // Create new price based on type
      const priceParams: Stripe.PriceCreateParams = {
        product: product.id,
        unit_amount: priceConfig.amount,
        currency: priceConfig.currency || "usd",
        metadata: {
          striped_price_key: priceKey,
          ...(priceConfig.trialPeriodDays && { trial_period_days: priceConfig.trialPeriodDays.toString() }),
        },
        tax_behavior: 'exclusive',
      };

      if (priceConfig.type === "recurring") {
        priceParams.recurring = {
          interval: priceConfig.interval as Stripe.Price.Recurring.Interval,
        };
      }

      price = await stripe.prices.create(priceParams);
      console.log(
        `Created price for product ${product.name}: $${priceConfig.amount / 100
        }/${priceConfig.type === "recurring" ? priceConfig.interval : "one-time"}${priceConfig.trialPeriodDays ? ` with ${priceConfig.trialPeriodDays}-day trial` : ''
        }`
      );
    } else {
      console.log(
        `Price for product ${product.name} already exists: $${priceConfig.amount / 100
        }/${priceConfig.type === "recurring" ? priceConfig.interval : "one-time"}`
      );
    }

    // Add the price ID to the mapping
    priceIdMapping[productKey].prices[priceKey] = price.id;
  }
  console.log(`All prices synchronized for product: ${product.name}`);
}

async function deployWebhooks(stripe: Stripe, config: PreStripedConfig) {
  if (!config.webhooks) {
    console.warn("No webhooks configured in the config file.");
    return;
  }

  console.log("Deploying webhooks...");
  const existingWebhooks = await stripe.webhookEndpoints.list({ limit: 100 });
  const existingEndpoint = existingWebhooks.data.find(
    wh => wh.url === config.webhooks?.endpoint
  );

  if (!existingEndpoint) {
    await stripe.webhookEndpoints.create({
      url: config.webhooks.endpoint,
      enabled_events: config.webhooks.events,
      api_version: config.apiVersion as Stripe.WebhookEndpointCreateParams.ApiVersion || "2024-11-20.acacia",
    });
    console.log(`Created new webhook endpoint: ${config.webhooks.endpoint}`);
  } else {
    await stripe.webhookEndpoints.update(existingEndpoint.id, {
      enabled_events: config.webhooks.events,
    });
    console.log(`Updated existing webhook endpoint: ${config.webhooks.endpoint}`);
  }
}