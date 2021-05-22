import * as React from "react";
import * as ReactDOM from "react-dom";

import App from "./App";

declare global {
  // tslint:disable-next-line
  interface Window {
    blockies: any;
  }
}

ReactDOM.render(
  <>
    <App />
  </>,
  document.getElementById("root"),
);

document.body.style.overflowX = 'hidden'