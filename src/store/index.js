import { combineReducers } from "redux";
import { reducer as FormReducer } from "redux-form";
import accountReducers from "../domain/account/reducers";
import authReducers from "../domain/auth/reducers";
import asyncReducer from "../domain/async/reducers";
import transactionReducers from "../domain/transaction/reducers";

const rootReducer = combineReducers({
  form: FormReducer,
  async: asyncReducer,
  auth: authReducers,
  accounts: accountReducers,
  transaction: transactionReducers
});

export default rootReducer;
