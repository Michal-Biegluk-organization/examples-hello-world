import { serveFile } from "jsr:@std/http@1/file-server";

Deno.serve((req: Request) => {
    return serveFile(req, "./index.html");
});
