import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters, APIGatewayProxyResult } from 'aws-lambda';
import AWS, { AWSError, ApiGatewayManagementApi } from 'aws-sdk';

type IAction = '$connect' | '$disconnect' | 'getAllConnections' | 'sendMessage' | 'getAllMessages' | 'deleteChat';
type IConnection = {
  connectionId: string,
  groupId: string,
  name: string
}
type IMessage = {
  groupId: string,
  connectionId: string,
  name: string,
  message: string,
  timeStamp: number
}
const CONNECTION_TABLE_NAME = "ChatConnections";
const MESSAGES_TABLE_NAME = "ChatMessages";
const responeOk = {
  statusCode: 200,
  body: ''
};
const responeError = {
  statusCode: 403,
  body: ''
};
const docClient = new AWS.DynamoDB.DocumentClient();
const apiGw = new ApiGatewayManagementApi({
  endpoint: process.env['WSSAPIGATEWAYENDPOINT']
});

export const handle = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {

  const connectionId = event.requestContext.connectionId as string;
  const routeKey = event.requestContext.routeKey as IAction;
  let parsesdMessage;

  switch (routeKey) {
    case '$connect':
      return handleConnect(connectionId, event.queryStringParameters);

    case '$disconnect':
      return handleDisConnect(connectionId);
    
    case 'sendMessage':
      return handleSendMessage(connectionId, event);

    case 'getAllConnections':
      if (!event.body) return responeError;
      parsesdMessage = JSON.parse(event.body) as IMessage;
      return handleGetAllConnections(connectionId, parsesdMessage.groupId);
      
    case 'getAllMessages':
      if (!event.body) return responeError;
      parsesdMessage = JSON.parse(event.body) as IMessage;
      return handleGetAllMessages(connectionId, parsesdMessage.groupId);
      
    case 'deleteChat':
      return handleDeleteChat(connectionId);
      
    default:
      return {
        statusCode: 500,
        body: ''
      };
  }
};

const handleConnect = async (connectionId: string, queryParams: APIGatewayProxyEventQueryStringParameters | null): Promise<APIGatewayProxyResult> => {
  if (!queryParams || !queryParams['groupId'] || !queryParams['name']) {
    return responeError;
  }
    const groupId = queryParams['groupId'];
    const name = queryParams['name'];
    const item = {
      connectionId,
      groupId: groupId,
      name: name
    };
    await docClient
    .put({
      TableName: CONNECTION_TABLE_NAME,
      Item: item,
    })
    .promise();
    
    await notifyConnection(connectionId, queryParams['groupId'], JSON.stringify([item]));    
    
    return responeOk;
  };

const handleDisConnect = async (connectionId: string): Promise<APIGatewayProxyResult> => {
  const output = await docClient
    .get({
      TableName: CONNECTION_TABLE_NAME,
      Key: {
        connectionId
      }
    })
    .promise();
    const connection = output.Item || {};
  
  await docClient
    .delete({
      TableName: CONNECTION_TABLE_NAME,
      Key: {
        connectionId
      }
    })
    .promise();

    await notifyConnection(connectionId, (connection as IConnection).groupId, JSON.stringify([connection]));

    return responeOk;
};

const notifyConnection = async (connectionIdToExclude: string, groupId: string, message: string) => {
  const connections = await getAllConnection();

  await Promise.all(
    connections
      .filter((connection) => (connection.connectionId !== connectionIdToExclude && connection.groupId === groupId))
      .map(async (connection) => {
        await postToConnection(connection.connectionId, message);
      }),
  );
};

const getAllConnection = async (): Promise<IConnection[]> => {
    const output = await docClient
      .scan({
        TableName: CONNECTION_TABLE_NAME,
      })
      .promise();
      
  const connections = output.Items || [];
  return connections as IConnection[];
};

const postToConnection = async (connectionId: string, data: string) => {
  try {
    await apiGw
      .postToConnection({
        ConnectionId: connectionId,
        Data: data,
      })
      .promise();
  } catch (e) {
    if ((e as AWSError).statusCode !== 410) {
      throw e;
    }
    await docClient
      .delete({
        TableName: CONNECTION_TABLE_NAME,
        Key: {
          connectionId,
        },
      })
      .promise();
  }
};

const handleSendMessage = async (connectionId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (!event.body) {
    return responeError;
  }

  const message: IMessage = JSON.parse(event.body) as IMessage;
  const item = {
    groupId: message.groupId,
    timeStamp: Date.now(),
    name: message.name,
    connectionId: connectionId,
    message: message.message
  };
  await docClient
    .put({
      TableName: MESSAGES_TABLE_NAME,
      Item: item
    })
    .promise();

    const output = await docClient.query({
      TableName: CONNECTION_TABLE_NAME,
      IndexName: "GroupIdIndex",
      KeyConditionExpression: "groupId = :groupId",
      ExpressionAttributeValues: {
        ":groupId": item.groupId
      }
    }).promise();
  
    const connections = output.Items || [];

    await Promise.all(
      connections
        .map(async (connection) => {
          await postToConnection(connection.connectionId, JSON.stringify([item]));
        }),
    );

  return responeOk;
};

const handleGetAllMessages = async (connectionId: string, groupId: string): Promise<APIGatewayProxyResult> => {
  const messages = await docClient
    .scan({
      TableName: MESSAGES_TABLE_NAME,
      FilterExpression: "groupId = :groupId",
      ExpressionAttributeValues: {
        ":groupId": groupId,
      },
    })
    .promise();
     
  await postToConnection(connectionId, JSON.stringify(messages.Items));

  return responeOk;
};

const getConnectionsJoinGroup = async (connectionId:string, groupId: String): Promise<IConnection[]> => {
  const output = await docClient.query({
    TableName: CONNECTION_TABLE_NAME,
    IndexName: "GroupIdIndex",
    KeyConditionExpression: "groupId = :groupId",
    ExpressionAttributeValues: {
      ":groupId": groupId
    }
  }).promise();

  const connections = output.Items || [];
  const excludedConnections = connections.filter((connection)=> connection.connectionId != connectionId);

  return excludedConnections as IConnection[];
};

const deleteChatIfGroupEmpty = async (connectionId:string, groupId: string) => {
  try {

    const connections: IConnection[] = await getConnectionsJoinGroup(connectionId, groupId);
    
    if (connections.length == 0) {
      const output = await docClient.scan({
        TableName: MESSAGES_TABLE_NAME,
        FilterExpression: "groupId = :groupId",
        ExpressionAttributeValues: {
          ":groupId": groupId
        }
      }).promise();
      if (output.Items) {
        const messages = output.Items;
        await Promise.all(
          messages.map(async (message) => {
            await docClient.delete({ TableName: MESSAGES_TABLE_NAME, Key: { groupId: groupId, timeStamp: message.timeStamp } }).promise();
          }),
        );
      }
    }
  } catch(e){
    throw({code: (e as AWSError).code, message:(e as AWSError).message});
  }
};

const handleDeleteChat = async (connectionId: string): Promise<APIGatewayProxyResult> => {
  const output = await docClient.get({
    TableName: CONNECTION_TABLE_NAME,
    Key: {
      connectionId
    }
  }).promise();

  const connection = output.Item || {};
  await deleteChatIfGroupEmpty(connectionId, (connection as IConnection).groupId);
  return responeOk;
};

const handleGetAllConnections = async (connectionId: string, groupId: string): Promise<APIGatewayProxyResult> => {
  const output = await docClient.query({
    TableName: CONNECTION_TABLE_NAME,
    IndexName: "GroupIdIndex",
    KeyConditionExpression: "groupId = :groupId",
    ExpressionAttributeValues: {
      ":groupId": groupId
    }
  }).promise();

  const connections = output.Items || [];

  await postToConnection(connectionId, JSON.stringify({connections, length: connections.length}));
  return responeOk;
}