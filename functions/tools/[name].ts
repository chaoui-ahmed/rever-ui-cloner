import { toolPage, findService } from "./_page";
export const onRequestGet: PagesFunction = ({ params }) => {
  const s = findService(String(params.name));
  return s ? toolPage(s) : new Response("Not found", { status: 404 });
};
