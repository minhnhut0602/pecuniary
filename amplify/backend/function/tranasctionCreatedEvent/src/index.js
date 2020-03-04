const https = require("https");
const AWS = require("aws-sdk");
const urlParse = require("url").URL;
const appsyncUrl = process.env.API_PECUNIARY_GRAPHQLAPIENDPOINTOUTPUT;
const region = process.env.REGION;
const endpoint = new urlParse(appsyncUrl).hostname.toString();
const apiKey = process.env.API_PECUNIARY_GRAPHQLAPIKEYOUTPUT;

exports.handler = async e => {
  var message = e.Records[0].Sns.Message;
  console.log("Message received:", message);

  var event = JSON.parse(message).message;
  console.log("Parsed event:", event);

  /******************
  // Create Transaction
   ******************/
  let createTransactionMutation = `mutation createTransaction {
        createTransactionReadModel(input: {
          aggregateId: "${event.aggregateId}"
          version: ${event.version}
          userId: "${event.userId}"
          transactionDate: "${event.data.transactionDate}"
          symbol: "${event.data.symbol}"
          shares: ${event.data.shares}
          price: ${event.data.price}
          commission: ${event.data.commission}
          transactionReadModelAccountId: "${event.data.transactionReadModelAccountId}"
          transactionReadModelTransactionTypeId: ${event.data.transactionReadModelTransactionTypeId}
          createdAt: "${event.createdAt}"
          updatedAt: "${event.createdAt}"
        })
        {
          id
          aggregateId
        }
      }`;
  console.debug("createTransaction: %j", createTransactionMutation);
  var createTransactionResult = await graphqlOperation(createTransactionMutation, "createTransaction");
  console.log("Created Transaction: %j", createTransactionResult);

  /******************
  // Update Positions
   ******************/
  // 1. Check if a position exists
  let getPositionQuery = `query getPosition {
    listPositionReadModels(filter: {
      aggregateId: {
        eq: "${event.aggregateId}"
      }
      symbol: {
        eq: "${event.data.symbol}"
      }
    })
    {
      items{
        id
        shares
        bookValue
      }
    }
  }`;
  console.debug("getPosition: %j", getPositionQuery);
  var positions = await graphqlOperation(getPositionQuery, "getPosition");
  console.log("Found Position: %j", positions);

  // 2. Check if position exists
  var bookValue;
  if (positions.data.listPositionReadModels.items.length <= 0) {
    console.log("Position doesn't exist...creating...");

    bookValue = event.data.shares * event.data.price - event.data.commission;
    var acb = bookValue / event.data.shares;

    var createPositionMutation = `mutation createPosition {
      createPositionReadModel(input: {
        aggregateId: "${event.aggregateId}"
        version: 1 
        userId: "${event.userId}"
        symbol: "${event.data.symbol}"
        shares: ${event.data.shares}
        acb: ${acb}
        bookValue: ${bookValue.toFixed(2)}
        createdAt: "${event.createdAt}"
        updatedAt: "${event.createdAt}"
        positionReadModelAccountId: "${event.data.transactionReadModelAccountId}"
      })
      {
        id
      }
    }`;
    console.debug("createPosition: %j", createPositionMutation);
    var createPositionResult = await graphqlOperation(createPositionMutation, "createPosition");
    console.log("Created Position: %j", createPositionResult);

    // Call AlphaVantage to get quote
    var timeSeries = await getTimeSeries(event.data.symbol, new Date(event.createdAt).toISOString().substring(0, 10));
    console.log(`TimeSeries for ${event.data.symbol}: `, timeSeries);
    // TODO Handle error

    // Create TimeSeries
    var createTimeSeriesMutation = `mutation createTimeSeries {
      createTimeSeries(input: {
        symbol: "${event.data.symbol}"
        date: "${timeSeries.date}"
        open: ${timeSeries["1. open"]}
        high: ${timeSeries["2. high"]}
        low: ${timeSeries["3. low"]}
        close: ${timeSeries["4. close"]}
        volume: ${timeSeries["5. volume"]}
      })
      {
        id
      }
    }`;
    console.debug("createTimeSeries: %j", createTimeSeriesMutation);
    var createTimeSeriesResult = await graphqlOperation(createTimeSeriesMutation, "createTimeSeries");
    console.log("Created TimeSeries: %j", createTimeSeriesResult);
  } else {
    console.log("Position exists...updating...");

    let shares;
    if (+event.data.transactionReadModelTransactionTypeId === 2) {
      // Sell
      shares = +positions.data.listPositionReadModels.items[0].shares - +event.data.shares;
      bookValue =
        (+positions.data.listPositionReadModels.items[0].bookValue /
          +positions.data.listPositionReadModels.items[0].shares) *
        (+positions.data.listPositionReadModels.items[0].shares - +event.data.shares);
    } else {
      // Buy
      shares = +positions.data.listPositionReadModels.items[0].shares + +event.data.shares;
      bookValue =
        +positions.data.listPositionReadModels.items[0].bookValue +
        (+event.data.shares * +event.data.price - +event.data.commission);
    }

    let acb = bookValue / shares;

    var updatePositionMutation = `mutation updatePosition {
      updatePositionReadModel(input: {
        id: "${positions.data.listPositionReadModels.items[0].id}"
        aggregateId: "${event.aggregateId}"
        symbol: "${event.data.symbol}"
        shares: ${shares}
        acb: ${acb.toFixed(2)}
        bookValue: ${bookValue}
        updatedAt: "${event.createdAt}"
      }) {
        id
        aggregateId
        symbol
        shares
        acb
        bookValue
        updatedAt
      }
    }`;
    console.debug("updatePosition: %j", updatePositionMutation);
    var updatePositionResult = await graphqlOperation(updatePositionMutation, "updatePosition");
    console.log("Updated Position: %j", updatePositionResult);
  }
  //

  /******************
  // Update Account book value
   ******************/
  // 1. Get Account
  var accountQuery = `query getAccount {
    getAccountReadModel(id: "${event.data.transactionReadModelAccountId}") 
    {
      id
      bookValue
    }
  }`;
  console.debug("getAccount: %j", accountQuery);
  var account = await graphqlOperation(accountQuery, "getAccount");
  console.log("Found Account: %j", account);

  // 2. Calculate new Account book value
  var newBookValue;
  if (+event.data.transactionReadModelTransactionTypeId === 2) {
    // Sell
    newBookValue =
      +account.data.getAccountReadModel.bookValue -
      +positions.data.listPositionReadModels.items[0].bookValue +
      (+positions.data.listPositionReadModels.items[0].bookValue /
        +positions.data.listPositionReadModels.items[0].shares) *
        (+positions.data.listPositionReadModels.items[0].shares - +event.data.shares);
  } else {
    // Buy
    newBookValue =
      +account.data.getAccountReadModel.bookValue + +(+event.data.shares * +event.data.price - +event.data.commission);
  }

  // 3. Update Account book value
  var updateAccountMutation = `mutation updateAccount {
    updateAccountReadModel(input: {
      id: "${event.data.transactionReadModelAccountId}"
      bookValue: ${newBookValue}
    })
    {
      id
    }
  }`;
  console.debug("updateAccount: %j", updateAccountMutation);
  var updatedAccountResult = await graphqlOperation(updateAccountMutation, "updateAccount");
  console.log("Updated Account: %j", updatedAccountResult);

  console.log(`Successfully processed ${e.Records.length} records.`);
};

async function getTimeSeries(symbol, date) {
  var result = await get(
    `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=SPRODHAE4BSL2OLB`
  );

  if (result["Error Message"]) {
    console.error("Error: ", result["Error Message"]);

    // Default to $0 for quotes not found
    return {
      "1. open": "0",
      "2. high": "0",
      "3. low": "0",
      "4. close": "0",
      "5. volume": "0"
    };
  } else if (!result["Time Series (Daily)"][`${date}`]) {
    var d = new Date(date);
    d.setDate(d.getDate() - 1);

    date = d.toISOString().substring(0, 10);
  }

  return { ...result["Time Series (Daily)"][`${date}`], date: date };
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      res.setEncoding("utf8");
      let body = "";

      res.on("data", chunk => {
        body += chunk;
      });

      res.on("end", () => {
        resolve(JSON.parse(body));
      });
    });

    req.on("error", err => {
      reject(err);
    });

    req.end();
  });
}

async function graphqlOperation(query, operationName) {
  const req = new AWS.HttpRequest(appsyncUrl, region);

  req.method = "POST";
  req.headers.host = endpoint;
  req.headers["Content-Type"] = "application/json";
  req.body = JSON.stringify({
    query: query,
    operationName: operationName
  });

  if (apiKey) {
    req.headers["x-api-key"] = apiKey;
  } else {
    const signer = new AWS.Signers.V4(req, "appsync", true);
    signer.addAuthorization(AWS.config.credentials, AWS.util.date.getDate());
  }

  const data = await new Promise((resolve, reject) => {
    const httpRequest = https.request({ ...req, host: endpoint }, result => {
      result.on("data", data => {
        resolve(JSON.parse(data.toString()));
      });
    });

    httpRequest.write(req.body);
    httpRequest.end();
  });

  return data;
}
