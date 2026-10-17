import { render } from "preact";
import "./styles.css";
import { App, ProjectPicker } from "./App.js";

const project = new URLSearchParams(location.search).get("project");
const root = document.getElementById("app")!;
render(project ? <App projectId={project} /> : <ProjectPicker />, root);
document.title = project ? "open-katana studio" : "open-katana studio · edits";
