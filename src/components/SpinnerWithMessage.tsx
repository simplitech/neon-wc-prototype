import * as React from "react";
import {Flex, Spinner, Text} from "@chakra-ui/react";

export default function SpinnerWithMessage(props: {message: string, xl: boolean}) {
  return (
    <Flex direction="column" align="center">
      <Spinner color="#0094FF" size={props.xl ? 'xl' : 'md'} thickness={props.xl ? '0.25rem' : '0.1rem'} />
      <Text mt={props.xl ? '1rem' : '0.4rem'} color="#004e87" fontSize={props.xl ? '2rem' : '1rem'}>{props.message}</Text>
    </Flex>
  );
};
