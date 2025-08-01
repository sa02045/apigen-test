#!/usr/bin/env node
import fs from "fs";
import path from "path";
import axios from "axios";
import { cosmiconfig } from "cosmiconfig";

let openapi: any;

type Schema = {
  $ref?: string;
  type?: string;
  enum?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  required?: string[];
  description?: string;
  format?: string;
};

type Content = {
  [mimeType: string]: {
    schema: Schema;
  };
};

type Operation = {
  operationId: string;
  requestBody?: {
    content: Content;
  };
  responses: {
    [statusCode: string]: {
      content?: Content;
    };
  };
};

type PathItem = {
  get?: Operation;
  post?: Operation;
  put?: Operation;
  delete?: Operation;
  patch?: Operation;
};

function mapOpenApiTypeToTsType(schema: Schema): string {
  if (schema.$ref) {
    const refName = schema.$ref.split("/").pop()!;
    const refSchema = openapi.components.schemas[refName];
    return `{\n${schemaToInterfaceBody(refSchema)}\n}`;
  }

  switch (schema.type) {
    case "string":
      if (schema.enum) {
        return schema.enum.map((e) => `'${e}'`).join(" | ");
      }
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      if (schema.items) {
        return `${mapOpenApiTypeToTsType(schema.items)}[]`;
      }
      return "any[]";
    case "object":
      if (schema.properties) {
        return `{\n${schemaToInterfaceBody(schema)}\n}`;
      }
      return "Record<string, any>";
    default:
      return "any";
  }
}

function schemaToInterfaceBody(schema: Schema): string {
  if (schema.$ref) {
    const refName = schema.$ref.split("/").pop()!;
    const refSchema = openapi.components.schemas[refName];
    return schemaToInterfaceBody(refSchema);
  }

  const requiredFields = new Set(schema.required || []);
  if (!schema.properties) {
    return "";
  }
  return Object.entries(schema.properties)
    .map(([key, propSchema]) => {
      const isRequired = requiredFields.has(key);
      let propString = "";
      if (propSchema.description) {
        propString += `  /**\n   * @description ${propSchema.description
          .trim()
          .replace(/\n/g, "\n   * ")}\n   */\n`;
      }
      propString += `  ${key}${isRequired ? "" : "?"}: ${mapOpenApiTypeToTsType(
        propSchema
      )};`;
      return propString;
    })
    .join("\n");
}

function parseApi(apiPath: string, method: string, config: any) {
  const pathItem = openapi.paths[apiPath] as PathItem;
  const methodKey = method as keyof PathItem;

  if (!pathItem || !pathItem[methodKey]) {
    return;
  }

  const operation = pathItem[methodKey]!;
  if (!operation.operationId) return;

  const operationIdRaw = operation.operationId;
  const operationId =
    operationIdRaw.charAt(0).toUpperCase() +
    operationIdRaw.slice(1).replace(/_\d+$/, "");

  // --- Request Body 처리 ---
  let requestBodyContent = "";
  const requestBodySchemaRef =
    operation.requestBody?.content?.["application/json"]?.schema?.$ref;

  if (requestBodySchemaRef) {
    const requestBodySchemaName = requestBodySchemaRef.split("/").pop()!;
    const requestBodySchema = openapi.components.schemas[requestBodySchemaName];
    requestBodyContent = schemaToInterfaceBody(requestBodySchema);
  }

  // --- Response Body 처리 ---
  let responseDataContent = "";
  const responseContent = operation.responses?.["200"]?.content;
  if (responseContent) {
    const responseSchemaRef =
      responseContent["*/*"]?.schema?.$ref ||
      responseContent["application/json"]?.schema?.$ref;

    if (responseSchemaRef) {
      const wrapperSchemaName = responseSchemaRef.split("/").pop()!;
      const wrapperSchema = openapi.components.schemas[wrapperSchemaName];
      const dataSchema = wrapperSchema.properties?.data;

      if (dataSchema) {
        responseDataContent = schemaToInterfaceBody(dataSchema);
      }
    }
  }

  // --- 파일 생성 ---
  const dirPath = path.join(
    config.output.path,
    apiPath.substring(1).replace(/{(\w+)}/g, "[$1]")
  );

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const fileName = `${method}${operationId}.ts`;
  const filePath = path.join(dirPath, fileName);

  const requestInterface = `export interface RequestBody {\n${requestBodyContent}\n}`;
  const responseInterface = `export interface Response {\n${responseDataContent}\n}`;

  const fileContent = `${requestInterface}\n\n${responseInterface}\n`;

  fs.writeFileSync(filePath, fileContent);
  console.log(`✅ Generated: ${filePath.replace(process.cwd(), "")}`);
}

function parseOpenApi(spec: any, config: any) {
  openapi = spec;
  console.log("🚀 Starting API type generation...");
  const paths = openapi.paths;
  for (const apiPath in paths) {
    const methods = paths[apiPath];
    for (const method in methods) {
      if (["get", "post", "put", "delete", "patch"].includes(method)) {
        parseApi(apiPath, method, config);
      }
    }
  }

  console.log("✨ Type generation finished!");
}

async function main() {
  const explorer = cosmiconfig("apigen");

  try {
    const result = await explorer.search();
    const config = result?.config ?? {
      output: {
        path: "./generated",
      },
    };

    const args = process.argv.slice(2);
    if (args.length === 0) {
      console.error("OpenAPI 명세 파일의 URL 혹은 파일 경로를 입력해주세요.");
      process.exit(1);
    }

    const input = args[0];

    let spec;
    if (input.startsWith("http://") || input.startsWith("https://")) {
      const response = await axios.get(input);
      spec = response.data;
    } else {
      const filePath = path.resolve(input);
      if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
      }
      const fileContent = fs.readFileSync(filePath, "utf-8");
      spec = JSON.parse(fileContent);
    }
    parseOpenApi(spec, config);
  } catch (error) {
    console.error("Failed to parse OpenAPI spec:", error);
    process.exit(1);
  }
}

main();
