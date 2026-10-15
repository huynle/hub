// OpenCode Hub console entry.
import { render } from "solid-js/web"
import { App } from "./app/App"
import { registerServiceWorker } from "./app/push"
import "./styles.css"

render(() => <App />, document.getElementById("root")!)
registerServiceWorker()
